import { redirect } from "next/navigation";

export default function SignupLoginMethodRedirectPage() {
  redirect("/auth/signup");
}
