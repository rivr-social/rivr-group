import { redirect } from "next/navigation";

export default function SignupConfirmRedirectPage() {
  redirect("/auth/signup");
}
