import { redirect } from "next/navigation";
import { DEFAULT_GLOBAL_IDENTITY_AUTHORITY_URL } from "@/app/actions/federated-login-types";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { safeRedirectUrl } from "@/lib/safe-redirect";

type SignupPageProps = {
  searchParams?: Promise<{
    callbackUrl?: string;
  }>;
};

export default async function SignupPage({ searchParams }: SignupPageProps) {
  const params = await searchParams;
  const callbackPath = safeRedirectUrl(params?.callbackUrl);
  const targetBaseUrl = getInstanceConfig().baseUrl.replace(/\/+$/, "");

  const returnUrl = new URL("/auth/login", targetBaseUrl);
  returnUrl.searchParams.set("callbackUrl", callbackPath);

  const globalSignupUrl = new URL(
    "/auth/signup",
    process.env.GLOBAL_IDENTITY_AUTHORITY_URL?.trim() ||
      DEFAULT_GLOBAL_IDENTITY_AUTHORITY_URL,
  );
  globalSignupUrl.searchParams.set("callbackUrl", returnUrl.toString());

  redirect(globalSignupUrl.toString());
}
