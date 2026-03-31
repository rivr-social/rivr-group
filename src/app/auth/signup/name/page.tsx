import { redirect } from "next/navigation";

export default function SignupNameRedirectPage() {
  redirect("/auth/signup");
}
