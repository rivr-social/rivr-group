import { redirect } from "next/navigation";

export default function SignupSaveLoginRedirectPage() {
  redirect("/auth/signup");
}
