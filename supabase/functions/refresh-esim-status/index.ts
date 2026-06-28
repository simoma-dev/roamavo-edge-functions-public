import { adminClient, authenticatedUser, corsHeaders, json, loadSecrets, syncOneEsim } from "../_shared/roamavo.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const admin = adminClient();
    const user = await authenticatedUser(admin, req);
    const secrets = await loadSecrets(admin, ["ESIM_ACCESS_ACCESS_CODE"]);
    const body = await req.json().catch(() => ({})) as { customerEsimId?: string; syncAll?: boolean };

    if (body.customerEsimId) {
      const synced = await syncOneEsim(admin, secrets, body.customerEsimId, user.id);
      return json({ synced: Boolean(synced) });
    }

    if (body.syncAll) {
      const { data: esims } = await admin
        .from("customer_esims")
        .select("id")
        .eq("user_id", user.id)
        .not("provider_esim_tran_no", "is", null)
        .limit(10)
        .returns<Array<{ id: string }>>();
      for (const esim of esims ?? []) {
        await syncOneEsim(admin, secrets, esim.id, user.id);
      }
      return json({ synced: esims?.length ?? 0 });
    }

    return json({ error: "Nothing to sync" }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Refresh failed" }, 500);
  }
});

