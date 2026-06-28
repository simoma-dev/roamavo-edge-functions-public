import { adminClient, corsHeaders, json, loadSecrets, requiredSecret, saveProfilesForOrder, syncOneEsim } from "../_shared/roamavo.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const admin = adminClient();
    const secrets = await loadSecrets(admin, ["ESIM_ACCESS_WEBHOOK_SECRET", "ESIM_ACCESS_ACCESS_CODE", "RESEND_API_KEY", "RESEND_FROM_EMAIL", "RESEND_REPLY_TO_EMAIL", "NEXT_PUBLIC_SITE_URL"]);
    const expectedSecret = requiredSecret(secrets, "ESIM_ACCESS_WEBHOOK_SECRET");
    const actualSecret = new URL(req.url).searchParams.get("secret");
    if (actualSecret !== expectedSecret) return json({ error: "Invalid webhook secret" }, 401);

    const payload = await req.json();
    const content = payload.content ?? {};
    const notifyType = String(payload.notifyType ?? "UNKNOWN");
    const notifyId = payload.notifyId ? String(payload.notifyId) : null;

    const { error: insertError } = await admin.from("provider_webhook_events").insert({
      provider: "esim_access",
      event_id: notifyId,
      event_type: notifyType,
      provider_order_no: content.orderNo ?? null,
      iccid: content.iccid ?? null,
      payload,
    });
    if (insertError?.code === "23505") return json({ received: true, duplicate: true });

    if (notifyType === "CHECK_HEALTH") return json({ received: true });

    if (notifyType === "ORDER_STATUS" && content.orderStatus === "GOT_RESOURCE" && content.orderNo) {
      await saveProfilesForOrder(admin, secrets, String(content.orderNo));
    } else if (content.esimTranNo || content.iccid) {
      const { data: esim } = await admin
        .from("customer_esims")
        .select("id")
        .or(`provider_esim_tran_no.eq.${content.esimTranNo ?? "__none__"},iccid.eq.${content.iccid ?? "__none__"}`)
        .limit(1)
        .maybeSingle<{ id: string }>();
      if (esim?.id) await syncOneEsim(admin, secrets, esim.id);
    }

    if (notifyId) {
      await admin.from("provider_webhook_events").update({ processed_at: new Date().toISOString() }).eq("event_id", notifyId);
    }
    return json({ received: true });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Webhook failed" }, 500);
  }
});

