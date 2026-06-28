import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.47.10";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export type AdminClient = SupabaseClient;

export type SecretBag = Record<string, string>;

export type PlanRow = {
  id: string;
  country_id: string;
  data_mb: number;
  validity_days: number;
  data_label: string;
  validity_label: string;
  retail_price_cents: number;
  currency: string;
  provider_package_code: string | null;
  provider_cost_cents: number | null;
  top_up_available: boolean | null;
  countries: { id: string; name: string; slug: string; iso_code: string; top_up_available: boolean | null };
};

export type OrderRow = {
  id: string;
  user_id: string;
  email: string;
  country_id: string;
  plan_id: string;
  amount_cents: number;
  currency: string;
  provider_transaction_id: string | null;
  provider_order_no: string | null;
  metadata: Record<string, unknown>;
};

type EsimPackage = {
  packageCode?: string;
  slug?: string;
  name?: string;
  price?: number;
  volume?: number;
  duration?: number;
  durationUnit?: string;
  location?: string;
  dataType?: number;
  supportTopUpType?: number;
  favorite?: boolean;
};

type EsimProfile = {
  esimTranNo?: string;
  orderNo?: string;
  transactionId?: string;
  imsi?: string;
  iccid?: string;
  msisdn?: string;
  ac?: string;
  qrCodeUrl?: string;
  shortUrl?: string;
  smdpStatus?: string;
  eid?: string;
  activeType?: number;
  dataType?: number;
  activateTime?: string | null;
  expiredTime?: string | null;
  installationTime?: string | null;
  totalVolume?: number;
  totalDuration?: number;
  durationUnit?: string;
  orderUsage?: number;
  esimStatus?: string;
  pin?: string;
  puk?: string;
  apn?: string;
  ipExport?: string;
  supportTopUpType?: number;
  fupPolicy?: string;
  packageList?: Array<{ packageCode?: string; slug?: string; packageName?: string; duration?: number; volume?: number; locationCode?: string }>;
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function adminClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) throw new Error("Supabase service credentials are not configured.");
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function authenticatedUser(admin: AdminClient, req: Request) {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) throw new Error("Missing authorization token.");
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new Error("Invalid authorization token.");
  return data.user;
}

export async function loadSecrets(admin: AdminClient, keys: string[]) {
  const bag: SecretBag = {};
  for (const key of keys) {
    const envValue = Deno.env.get(key);
    if (envValue) bag[key] = envValue;
  }

  const missing = keys.filter((key) => !bag[key]);
  if (missing.length) {
    const { data } = await admin
      .rpc("roamavo_get_app_secrets", { p_keys: missing })
      .returns<Array<{ key: string; value: string }>>();

    for (const row of data ?? []) {
      if (row.value) bag[row.key] = row.value;
    }
  }

  return bag;
}

export function requiredSecret(secrets: SecretBag, key: string) {
  const value = secrets[key];
  if (!value) throw new Error(`Missing server secret: ${key}`);
  return value;
}

export async function stripeRequest(secretKey: string, path: string, params: Record<string, string | number | boolean | null | undefined>) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) body.set(key, String(value));
  }

  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message ?? `Stripe request failed: ${response.status}`);
  return payload;
}

export async function esimAccessRequest<T>(secrets: SecretBag, path: string, body: Record<string, unknown> = {}) {
  const response = await fetch(`https://api.esimaccess.com/api/v1/open/${path}`, {
    method: "POST",
    headers: {
      "RT-AccessCode": requiredSecret(secrets, "ESIM_ACCESS_ACCESS_CODE"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json();
  if (!response.ok || payload?.success === false) {
    throw new Error(payload?.errorMsg ?? payload?.errorMessage ?? payload?.errorCode ?? `eSIM Access request failed: ${response.status}`);
  }
  return payload as T;
}

function providerMb(bytes?: number) {
  return Math.round((Number(bytes ?? 0) / 1_073_741_824) * 1000);
}

function expectedProviderMiB(dataMb: number) {
  return Math.round((dataMb * 1024) / 1000);
}

function packageScore(plan: PlanRow, pkg: EsimPackage) {
  const iso = plan.countries.iso_code.toUpperCase();
  const locations = String(pkg.location ?? "").split(",").map((item) => item.trim().toUpperCase()).filter(Boolean);
  const locationPenalty = locations.length === 1 && locations[0] === iso ? 0 : 100000;
  const dataPenalty = Math.abs(Math.round(Number(pkg.volume ?? 0) / 1024 / 1024) - expectedProviderMiB(plan.data_mb));
  const dataTypePenalty = Number(pkg.dataType ?? 1) === 1 ? 0 : 10000;
  const favoriteBonus = pkg.favorite ? -100 : 0;
  return locationPenalty + dataTypePenalty + dataPenalty + favoriteBonus;
}

export async function resolveBasePackage(admin: AdminClient, secrets: SecretBag, plan: PlanRow) {
  if (plan.provider_package_code) return plan.provider_package_code;

  const payload = await esimAccessRequest<{ obj?: { packageList?: EsimPackage[] } }>(secrets, "package/list", {
    locationCode: plan.countries.iso_code.toUpperCase(),
    type: "BASE",
  });

  const expectedMiB = expectedProviderMiB(plan.data_mb);
  const match = (payload.obj?.packageList ?? [])
    .filter((pkg) => Number(pkg.duration) === Number(plan.validity_days))
    .filter((pkg) => Math.abs(Math.round(Number(pkg.volume ?? 0) / 1024 / 1024) - expectedMiB) <= 8)
    .sort((a, b) => packageScore(plan, a) - packageScore(plan, b))[0];

  if (!match) throw new Error(`No eSIM Access package matches ${plan.countries.name} ${plan.data_label} ${plan.validity_label}.`);

  const providerCode = match.slug || match.packageCode;
  await admin
    .from("plans")
    .update({
      provider_package_code: providerCode,
      provider_cost_cents: Math.round(Number(match.price ?? 0) / 100),
      top_up_available: Boolean(plan.top_up_available) && [2, 3].includes(Number(match.supportTopUpType ?? 1)),
      metadata: {
        provider_raw_package_code: match.packageCode ?? null,
        provider_support_top_up_type: match.supportTopUpType ?? null,
        provider_data_type: match.dataType ?? null,
        provider_name: match.name ?? null,
      },
    })
    .eq("id", plan.id);

  return providerCode;
}

export async function resolveTopUpPackage(secrets: SecretBag, plan: PlanRow, esimTranNo: string) {
  const payload = await esimAccessRequest<{ obj?: { packageList?: EsimPackage[] } }>(secrets, "package/list", {
    type: "TOPUP",
    esimTranNo,
  });

  const expectedMiB = expectedProviderMiB(plan.data_mb);
  const match = (payload.obj?.packageList ?? [])
    .filter((pkg) => Number(pkg.duration) === Number(plan.validity_days))
    .filter((pkg) => Math.abs(Math.round(Number(pkg.volume ?? 0) / 1024 / 1024) - expectedMiB) <= 8)
    .sort((a, b) => packageScore(plan, a) - packageScore(plan, b))[0];

  if (!match) throw new Error(`No compatible top-up package matches ${plan.data_label} ${plan.validity_label}.`);
  return match.slug || match.packageCode;
}

export function parseActivationCode(ac?: string) {
  const parts = String(ac ?? "").split("$");
  return {
    smdpAddress: parts[1] ?? null,
    matchingId: parts[2] ?? null,
  };
}

function escapeHtml(value?: string | null) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function normalizeProviderStatus(esimStatus?: string, smdpStatus?: string) {
  const esim = String(esimStatus ?? "").toUpperCase();
  const smdp = String(smdpStatus ?? "").toUpperCase();
  if (["USED_EXPIRED", "UNUSED_EXPIRED", "CANCEL", "REVOKED", "REVOKE"].includes(esim)) return "expired";
  if (esim === "USED_UP") return "depleted";
  if (esim === "IN_USE") return "active";
  if (smdp === "RELEASED" || esim === "GOT_RESOURCE") return "ready";
  return "pending";
}

export async function sendDeliveryEmail(admin: AdminClient, secrets: SecretBag, order: OrderRow, profiles: EsimProfile[], mode: "new" | "topup") {
  const resendApiKey = requiredSecret(secrets, "RESEND_API_KEY");
  const from = requiredSecret(secrets, "RESEND_FROM_EMAIL") || "Roamavo <support@auth.roamavo.com>";
  const replyTo = secrets.RESEND_REPLY_TO_EMAIL || "support@roamavo.com";
  const siteUrl = secrets.NEXT_PUBLIC_SITE_URL || "https://roamavo.com";

  const { data: plan } = await admin
    .from("plans")
    .select("data_label, validity_label, countries!inner(name)")
    .eq("id", order.plan_id)
    .maybeSingle<{ data_label: string; validity_label: string; countries: { name: string } }>();

  const title = mode === "topup" ? "Your Roamavo top-up is complete" : "Your Roamavo eSIM is ready";
  const profileHtml = profiles.map((profile, index) => {
    const activation = parseActivationCode(profile.ac);
    return `
      <div style="border:1px solid #d9e4e1;border-radius:16px;padding:18px;margin:18px 0;background:#ffffff;">
        <h2 style="margin:0 0 12px;font-size:18px;line-height:1.3;color:#093332;">${profiles.length > 1 ? `eSIM ${index + 1}` : "Installation details"}</h2>
        ${profile.qrCodeUrl ? `<p style="margin:0 0 16px;"><img src="${escapeHtml(profile.qrCodeUrl)}" alt="eSIM QR code" width="220" style="max-width:100%;border:1px solid #d9e4e1;border-radius:14px;padding:12px;background:#f7faf9;" /></p>` : ""}
        <p style="margin:10px 0;"><strong>ICCID:</strong> ${escapeHtml(profile.iccid || "Pending")}</p>
        <p style="margin:10px 0;"><strong>Activation code:</strong><br /><span style="word-break:break-all;">${escapeHtml(profile.ac || "Pending")}</span></p>
        ${activation.smdpAddress ? `<p style="margin:10px 0;"><strong>SM-DP+ address:</strong> ${escapeHtml(activation.smdpAddress)}</p>` : ""}
        ${activation.matchingId ? `<p style="margin:10px 0;"><strong>Matching ID:</strong> <span style="word-break:break-all;">${escapeHtml(activation.matchingId)}</span></p>` : ""}
        ${profile.apn ? `<p style="margin:10px 0;"><strong>APN:</strong> ${escapeHtml(profile.apn)}</p>` : ""}
        ${profile.pin ? `<p style="margin:10px 0;"><strong>PIN:</strong> ${escapeHtml(profile.pin)}</p>` : ""}
        ${profile.puk ? `<p style="margin:10px 0;"><strong>PUK:</strong> ${escapeHtml(profile.puk)}</p>` : ""}
      </div>`;
  }).join("");

  const html = `
    <div style="margin:0;padding:0;background:#f4f7f6;">
      <div style="max-width:640px;margin:0 auto;padding:28px 16px;font-family:Arial,Helvetica,sans-serif;color:#0b1f1f;line-height:1.55;">
        <div style="border-radius:20px;overflow:hidden;background:#ffffff;border:1px solid #d9e4e1;">
          <div style="background:#075E5F;padding:22px 24px;color:#ffffff;">
            <div style="font-size:24px;font-weight:800;letter-spacing:0.2px;">Roamavo</div>
            <div style="margin-top:6px;font-size:13px;font-weight:700;color:#d8f2ee;">Travel data, ready when you land</div>
          </div>
          <div style="padding:24px;">
            <h1 style="margin:0 0 12px;font-size:26px;line-height:1.2;color:#093332;">${escapeHtml(title)}</h1>
            <p style="margin:0 0 16px;color:#405453;">${escapeHtml(plan?.countries.name ?? "Your destination")} ${escapeHtml(plan?.data_label ?? "")} ${escapeHtml(plan?.validity_label ?? "")}</p>
            ${profileHtml || `<div style="border:1px solid #d9e4e1;border-radius:16px;padding:18px;margin:18px 0;background:#f7faf9;">Your top-up has been added to your active eSIM.</div>`}
            <p style="margin:20px 0 0;">You can also view your eSIM in your Roamavo dashboard:</p>
            <p style="margin:10px 0 0;"><a href="${escapeHtml(siteUrl)}/dashboard" style="display:inline-block;background:#075E5F;color:#ffffff;text-decoration:none;border-radius:999px;padding:12px 18px;font-weight:700;">Open dashboard</a></p>
          </div>
          <div style="border-top:1px solid #d9e4e1;padding:16px 24px;font-size:13px;color:#5d6b6b;background:#f7faf9;">
            Need help? Reply to this email or contact support@roamavo.com.
          </div>
        </div>
      </div>
    </div>`;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: order.email,
      reply_to: replyTo,
      subject: title,
      html,
    }),
  });

  if (!response.ok) throw new Error(`Resend email failed: ${response.status} ${await response.text()}`);
}

export async function saveProfilesForOrder(admin: AdminClient, secrets: SecretBag, providerOrderNo: string) {
  const { data: order } = await admin
    .from("orders")
    .select("id,user_id,email,country_id,plan_id,amount_cents,currency,provider_transaction_id,provider_order_no,metadata")
    .eq("provider_order_no", providerOrderNo)
    .maybeSingle<OrderRow>();

  if (!order) throw new Error(`No Roamavo order found for provider order ${providerOrderNo}.`);

  const payload = await esimAccessRequest<{ obj?: { esimList?: EsimProfile[] } }>(secrets, "esim/query", {
    orderNo: providerOrderNo,
    pager: { pageNum: 1, pageSize: 50 },
  });

  const profiles = payload.obj?.esimList ?? [];
  if (!profiles.length) throw new Error(`Provider order ${providerOrderNo} has no allocated profiles yet.`);

  for (const profile of profiles) {
    const activation = parseActivationCode(profile.ac);
    const dataTotalMb = providerMb(profile.totalVolume);
    const dataUsedMb = providerMb(profile.orderUsage);
    const row = {
      user_id: order.user_id,
      order_id: order.id,
      country_id: order.country_id,
      plan_id: order.plan_id,
      provider: "esim_access",
      provider_order_no: profile.orderNo ?? providerOrderNo,
      provider_esim_tran_no: profile.esimTranNo ?? null,
      iccid: profile.iccid ?? null,
      activation_code: profile.ac ?? null,
      qr_code_url: profile.qrCodeUrl ?? null,
      smdp_address: activation.smdpAddress,
      matching_id: activation.matchingId,
      smdp_status: profile.smdpStatus ?? null,
      esim_status: normalizeProviderStatus(profile.esimStatus, profile.smdpStatus),
      data_total_mb: dataTotalMb,
      data_used_mb: dataUsedMb,
      data_remaining_mb: Math.max(0, dataTotalMb - dataUsedMb),
      validity_days: profile.totalDuration ?? null,
      activated_at: profile.activateTime ?? null,
      expires_at: profile.expiredTime ?? null,
      last_synced_at: new Date().toISOString(),
      top_up_available: [2, 3].includes(Number(profile.supportTopUpType ?? 1)),
      metadata: {
        short_url: profile.shortUrl ?? null,
        imsi: profile.imsi ?? null,
        msisdn: profile.msisdn ?? null,
        eid: profile.eid ?? null,
        active_type: profile.activeType ?? null,
        data_type: profile.dataType ?? null,
        installation_time: profile.installationTime ?? null,
        pin: profile.pin ?? null,
        puk: profile.puk ?? null,
        apn: profile.apn ?? null,
        ip_export: profile.ipExport ?? null,
        fup_policy: profile.fupPolicy ?? null,
        package_list: profile.packageList ?? [],
      },
      updated_at: new Date().toISOString(),
    };

    if (profile.iccid) {
      await admin.from("customer_esims").upsert(row, { onConflict: "iccid" });
    } else {
      await admin.from("customer_esims").insert(row);
    }
  }

  await admin
    .from("orders")
    .update({ status: "fulfilled", fulfilled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", order.id);

  await sendDeliveryEmail(admin, secrets, order, profiles, "new");
  return profiles;
}

export async function syncOneEsim(admin: AdminClient, secrets: SecretBag, customerEsimId: string, userId?: string) {
  let query = admin
    .from("customer_esims")
    .select("id,user_id,provider_esim_tran_no,iccid,provider_order_no,data_total_mb")
    .eq("id", customerEsimId);
  if (userId) query = query.eq("user_id", userId);

  const { data: esim } = await query.maybeSingle<{
    id: string;
    user_id: string;
    provider_esim_tran_no: string | null;
    iccid: string | null;
    provider_order_no: string | null;
    data_total_mb: number | null;
  }>();

  if (!esim || !esim.provider_esim_tran_no) return null;

  const [statusPayload, usagePayload] = await Promise.all([
    esimAccessRequest<{ obj?: { esimList?: EsimProfile[] } }>(secrets, "esim/query", {
      esimTranNo: esim.provider_esim_tran_no,
      pager: { pageNum: 1, pageSize: 5 },
    }),
    esimAccessRequest<{ obj?: { esimUsageList?: Array<{ esimTranNo: string; dataUsage: number; totalData: number; lastUpdateTime: string }> } }>(secrets, "esim/usage/query", {
      esimTranNoList: [esim.provider_esim_tran_no],
    }).catch(() => null),
  ]);

  const profile = statusPayload.obj?.esimList?.[0];
  const usage = usagePayload?.obj?.esimUsageList?.[0];
  const totalMb = providerMb(usage?.totalData ?? profile?.totalVolume);
  const usedMb = providerMb(usage?.dataUsage ?? profile?.orderUsage);
  const remainingMb = Math.max(0, totalMb - usedMb);
  const activation = parseActivationCode(profile?.ac);

  const update = {
    provider_order_no: profile?.orderNo ?? esim.provider_order_no,
    provider_esim_tran_no: profile?.esimTranNo ?? esim.provider_esim_tran_no,
    iccid: profile?.iccid ?? esim.iccid,
    activation_code: profile?.ac ?? undefined,
    qr_code_url: profile?.qrCodeUrl ?? undefined,
    smdp_address: activation.smdpAddress ?? undefined,
    matching_id: activation.matchingId ?? undefined,
    smdp_status: profile?.smdpStatus ?? undefined,
    esim_status: normalizeProviderStatus(profile?.esimStatus, profile?.smdpStatus),
    data_total_mb: totalMb || esim.data_total_mb,
    data_used_mb: usedMb,
    data_remaining_mb: remainingMb,
    validity_days: profile?.totalDuration ?? undefined,
    activated_at: profile?.activateTime ?? undefined,
    expires_at: profile?.expiredTime ?? undefined,
    last_synced_at: usage?.lastUpdateTime ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  await admin.from("customer_esims").update(update).eq("id", esim.id);
  await admin.from("esim_usage_snapshots").insert({
    customer_esim_id: esim.id,
    data_used_mb: usedMb,
    data_remaining_mb: remainingMb,
    payload: { profile, usage },
  });
  return update;
}
