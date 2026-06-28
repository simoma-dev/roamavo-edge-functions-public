import { adminClient, authenticatedUser, corsHeaders, json, loadSecrets, requiredSecret, resolveBasePackage, resolveTopUpPackage, stripeRequest, type PlanRow } from "../_shared/roamavo.ts?v=20260628-rpc-secrets";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const admin = adminClient();
    const user = await authenticatedUser(admin, req);
    const secrets = await loadSecrets(admin, [
      "STRIPE_SECRET_KEY",
      "ESIM_ACCESS_ACCESS_CODE",
      "NEXT_PUBLIC_SITE_URL",
    ]);
    const body = await req.json() as { planId?: string; quantity?: number; mode?: "new" | "topup" };
    const planId = String(body.planId ?? "");
    const quantity = Math.max(1, Math.min(Number(body.quantity ?? 1) || 1, 20));
    const mode = body.mode === "topup" ? "topup" : "new";

    const { data: plan, error: planError } = await admin
      .from("plans")
      .select("id,country_id,data_mb,validity_days,data_label,validity_label,retail_price_cents,currency,provider_package_code,provider_cost_cents,top_up_available,countries!inner(id,name,slug,iso_code,top_up_available)")
      .eq("id", planId)
      .eq("is_active", true)
      .maybeSingle<PlanRow>();
    if (planError || !plan) return json({ error: "Plan unavailable" }, 404);

    if (mode === "new") {
      await resolveBasePackage(admin, secrets, plan);
    }

    let targetCustomerEsimId: string | null = null;
    if (mode === "topup") {
      if (!plan.top_up_available || !plan.countries.top_up_available) return json({ error: "Top-up is not available for this plan" }, 400);
      const { data: activeEsim } = await admin
        .from("customer_esims")
        .select("id,provider_esim_tran_no")
        .eq("user_id", user.id)
        .eq("country_id", plan.country_id)
        .eq("top_up_available", true)
        .in("esim_status", ["active", "ready", "pending", "depleted", "IN_USE", "GOT_RESOURCE", "USED_UP"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle<{ id: string; provider_esim_tran_no: string | null }>();
      if (!activeEsim?.provider_esim_tran_no) return json({ error: "No active eSIM is available for top-up" }, 400);
      await resolveTopUpPackage(secrets, plan, activeEsim.provider_esim_tran_no);
      targetCustomerEsimId = activeEsim.id;
    }

    const amountCents = plan.retail_price_cents * quantity;
    const { data: order, error: orderError } = await admin
      .from("orders")
      .insert({
        user_id: user.id,
        email: user.email ?? "",
        country_id: plan.country_id,
        plan_id: plan.id,
        status: "pending_payment",
        amount_cents: amountCents,
        currency: plan.currency,
        provider: "esim_access",
        metadata: {
          mode,
          quantity,
          target_customer_esim_id: targetCustomerEsimId,
          plan_data_mb: plan.data_mb,
          plan_data_label: plan.data_label,
          validity_days: plan.validity_days,
        },
      })
      .select("id")
      .single<{ id: string }>();
    if (orderError || !order) throw new Error(orderError?.message ?? "Unable to create order");

    const providerTransactionId = `rv_${order.id.replaceAll("-", "")}`;
    await admin.from("orders").update({ provider_transaction_id: providerTransactionId }).eq("id", order.id);

    const siteUrl = requiredSecret(secrets, "NEXT_PUBLIC_SITE_URL").replace(/\/$/, "");
    const stripeParams: Record<string, string | number | boolean | null | undefined> = {
      mode: "payment",
      ui_mode: "elements",
      return_url: `${siteUrl}/checkout/success?country=${encodeURIComponent(plan.countries.slug)}&mode=${mode}&session_id={CHECKOUT_SESSION_ID}`,
      customer_email: user.email ?? "",
      client_reference_id: order.id,
      "payment_method_types[0]": "card",
      "line_items[0][quantity]": quantity,
      "line_items[0][price_data][currency]": plan.currency.toLowerCase(),
      "line_items[0][price_data][unit_amount]": plan.retail_price_cents,
      "line_items[0][price_data][product_data][name]": `${plan.countries.name} ${mode === "topup" ? "top-up" : "eSIM"} - ${plan.data_label} ${plan.validity_label}`,
      "invoice_creation[enabled]": true,
      "metadata[order_id]": order.id,
      "metadata[user_id]": user.id,
      "metadata[plan_id]": plan.id,
      "metadata[mode]": mode,
    };

    const session = await stripeRequest(requiredSecret(secrets, "STRIPE_SECRET_KEY"), "checkout/sessions", stripeParams);

    await admin.from("orders").update({ stripe_checkout_session_id: session.id, updated_at: new Date().toISOString() }).eq("id", order.id);
    return json({ clientSecret: session.client_secret, sessionId: session.id });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Checkout could not be started" }, 500);
  }
});
