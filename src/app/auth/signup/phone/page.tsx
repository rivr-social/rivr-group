import { redirect } from "next/navigation";

export default function SignupPhoneRedirectPage() {
  redirect("/auth/signup");
}
