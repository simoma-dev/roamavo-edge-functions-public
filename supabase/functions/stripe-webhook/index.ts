import { adminClient, corsHeaders, esimAccessRequest, json, loadSecrets, requiredSecret, resolveBasePackage, resolveTopUpPackage, saveProfilesForOrder, sendDeliveryEmail, type OrderRow, type PlanRow } from "../_shared/roamavo.ts?v=20260628-rpc-secrets";

function hex(buffer: ArrayBuffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyStripeSignature(rawBody: string, signature: string | null, secret: string) {
  if (!signature) return false;
  const parts = Object.fromEntries(signature.split(",").map((part) => {
    const [key, value] = part.split("=");
    return [key, value];
  }));
  if (!parts.t || !parts.v1) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${parts.t}.${rawBody}`));
  return hex(signed) === parts.v1;
}

async function fulfillPaidOrder(admin: ReturnType<typeof adminClient>, secrets: Record<string, string>, order: OrderRow) {
  const mode = order.metadata?.mode === "topup" ? "topup" : "new";
  const { data: plan } = await admin
    .from("plans")
    .select("id,country_id,data_mb,validity_days,data_label,validity_label,retail_price_cents,currency,provider_package_code,provider_cost_cents,top_up_available,countries!inner(id,name,slug,iso_code,top_up_available)")
    .eq("id", order.plan_id)
    .single<PlanRow>();
  if (!plan) throw new Error("Order plan is unavailable");

  if (mode === "topup") {
    const targetId = String(order.metadata?.target_customer_esim_id ?? "");
    const { data: esim } = await admin
      .from("customer_esims")
      .select("id,provider_esim_tran_no,iccid")
      .eq("id", targetId)
      .eq("user_id", order.user_id)
      .maybeSingle<{ id: string; provider_esim_tran_no: string | null; iccid: string | null }>();
    if (!esim?.provider_esim_tran_no) throw new Error("Top-up target eSIM is unavailable");
    const topupPackage = await resolveTopUpPackage(secrets, plan, esim.provider_esim_tran_no);
    const payload = await esimAccessRequest<{ obj?: { expiredTime?: string; totalVolume?: number; totalDuration?: number; orderUsage?: number; topUpEsimTranNo?: string } }>(secrets, "esim/topup", {
      esimTranNo: esim.provider_esim_tran_no,
      packageCode: topupPackage,
      transactionId: `${order.provider_transaction_id}_topup`,
    });
    const totalMb = Math.round((Number(payload.obj?.totalVolume ?? 0) / 1_073_741_824) * 1000);
    const usedMb = Math.round((Number(payload.obj?.orderUsage ?? 0) / 1_073_741_824) * 1000);
    await admin.from("customer_esims").update({
      data_total_mb: totalMb,
      data_used_mb: usedMb,
      data_remaining_mb: Math.max(0, totalMb - usedMb),
      validity_days: payload.obj?.totalDuration ?? undefined,
      expires_at: payload.obj?.expiredTime ?? undefined,
      last_synced_at: new Date().toISOString(),
      metadata: { last_top_up_order_id: order.id, top_up_provider_transaction_no: payload.obj?.topUpEsimTranNo ?? null },
      updated_at: new Date().toISOString(),
    }).eq("id", esim.id);
    await admin.from("orders").update({ status: "fulfilled", fulfilled_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", order.id);
    await sendDeliveryEmail(admin, secrets, order, [], "topup");
    return;
  }

  const packageCode = await resolveBasePackage(admin, secrets, plan);
  const quantity = Math.max(1, Number(order.metadata?.quantity ?? 1) || 1);
  const providerOrder = await esimAccessRequest<{ obj?: { orderNo?: string } }>(secrets, "esim/order", {
    transactionId: order.provider_transaction_id,
    packageInfoList: [{ packageCode, count: quantity }],
  });
  const providerOrderNo = providerOrder.obj?.orderNo;
  if (!providerOrderNo) throw new Error("eSIM Access did not return an order number");
  await admin.from("orders").update({ status: "provisioning", provider_order_no: providerOrderNo, updated_at: new Date().toISOString() }).eq("id", order.id);

  try {
    await saveProfilesForOrder(admin, secrets, providerOrderNo);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Waiting for provider allocation";
    if (!message.includes("200010")) console.warn(message);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = adminClient();
  const secrets = await loadSecrets(admin, ["STRIPE_WEBHOOK_SIGNING_SECRET", "ESIM_ACCESS_ACCESS_CODE", "RESEND_API_KEY", "RESEND_FROM_EMAIL", "RESEND_REPLY_TO_EMAIL", "NEXT_PUBLIC_SITE_URL"]);
  const rawBody = await req.text();
  const valid = await verifyStripeSignature(rawBody, req.headers.get("stripe-signature"), requiredSecret(secrets, "STRIPE_WEBHOOK_SIGNING_SECRET"));
  if (!valid) return json({ error: "Invalid signature" }, 400);

  const event = JSON.parse(rawBody);
  const eventId = String(event.id ?? "");
  const eventType = String(event.type ?? "");
  const session = event.data?.object ?? {};
  const orderId = session.metadata?.order_id ?? session.client_reference_id;

  const { error: eventError } = await admin.from("payment_events").insert({
    provider: "stripe",
    event_id: eventId,
    event_type: eventType,
    order_id: orderId || null,
    payload: event,
  });
  if (eventError?.code === "23505") return json({ received: true, duplicate: true });

  if (eventType === "checkout.session.completed" && orderId) {
    const { data: order } = await admin
      .from("orders")
      .select("id,user_id,email,country_id,plan_id,amount_cents,currency,provider_transaction_id,provider_order_no,metadata")
      .eq("id", orderId)
      .maybeSingle<OrderRow>();

    if (order) {
      await admin.from("orders").update({
        status: "paid",
        paid_at: new Date().toISOString(),
        stripe_checkout_session_id: session.id,
        stripe_payment_intent_id: session.payment_intent ?? null,
        updated_at: new Date().toISOString(),
      }).eq("id", order.id);
      await fulfillPaidOrder(admin, secrets, order);
    }
  }

  await admin.from("payment_events").update({ processed_at: new Date().toISOString() }).eq("event_id", eventId);
  return json({ received: true });
});
