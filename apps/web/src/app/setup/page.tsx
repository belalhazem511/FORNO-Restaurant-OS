"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";

export const dynamic = "force-dynamic";

export default function DesktopSetupPage() {
  const search = useSearchParams();
  const locale = search.get("locale") === "ar" ? "ar" : "en";
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { document.cookie = `locale=${locale}; path=/; SameSite=Lax`; }, [locale]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      if (!window.fornoDesktop) throw new Error("This setup screen is available only inside the SOLO desktop application.");
      await window.fornoDesktop.completeOwnerSetup({
        name: String(data.get("name") ?? ""),
        email: String(data.get("email") ?? ""),
        password: String(data.get("password") ?? ""),
        branchName: String(data.get("branch") ?? ""),
        registerName: String(data.get("register") ?? ""),
        locale,
      });
      location.assign("/login");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Local setup could not be completed.");
    } finally {
      setSaving(false);
    }
  }

  const arabic = locale === "ar";
  const label = (en: string, ar: string) => arabic ? ar : en;
  return <main dir={arabic ? "rtl" : "ltr"} lang={locale} className="mx-auto max-w-xl p-6">
    <h1 className="text-2xl font-bold">{label("Create the local Owner account", "إنشاء حساب المالك المحلي")}</h1>
    <p className="my-3">{label("This account and restaurant stay on this device until you explicitly pair and synchronize it.", "يبقى هذا الحساب والمطعم على هذا الجهاز حتى تقرن الجهاز وتزامنه صراحةً.")}</p>
    <form className="grid gap-4" onSubmit={submit}>
      <label>{label("Owner name", "اسم المالك")}<input required minLength={2} name="name" autoComplete="name" className="mt-1 w-full rounded border p-2" /></label>
      <label>{label("Email", "البريد الإلكتروني")}<input required type="email" name="email" autoComplete="email" className="mt-1 w-full rounded border p-2" /></label>
      <label>{label("Password (12 characters minimum)", "كلمة المرور (12 حرفاً على الأقل)")}<input required type="password" minLength={12} maxLength={128} name="password" autoComplete="new-password" className="mt-1 w-full rounded border p-2" /></label>
      <label>{label("Restaurant / branch name", "اسم المطعم / الفرع")}<input required minLength={2} name="branch" className="mt-1 w-full rounded border p-2" /></label>
      <label>{label("Register name", "اسم نقطة البيع")}<input required minLength={2} name="register" className="mt-1 w-full rounded border p-2" /></label>
      {error && <p role="alert" className="text-red-700">{error}</p>}
      <button disabled={saving} className="rounded bg-primary p-3 text-primary-foreground">{saving ? label("Creating…", "جارٍ الإنشاء…") : label("Create local restaurant", "إنشاء المطعم المحلي")}</button>
    </form>
  </main>;
}
