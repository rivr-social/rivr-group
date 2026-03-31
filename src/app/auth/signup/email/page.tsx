import { redirect } from "next/navigation";

export default function SignupEmailRedirectPage() {
  redirect("/auth/signup");
}
