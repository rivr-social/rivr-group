import { redirect } from "next/navigation";

export default function SignupBirthdayRedirectPage() {
  redirect("/auth/signup");
}
