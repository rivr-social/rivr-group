import { NextResponse } from "next/server";
import { sendTrialEndingRemindersAction } from "@/app/actions/billing";

function isAuthorized(request: Request): boolean {
  const configuredSecret = process.env.BILLING_CRON_SECRET;
  if (!configuredSecret) return false;

  const authHeader = request.headers.get("authorization");
  return authHeader === `Bearer ${configuredSecret}`;
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await sendTrialEndingRemindersAction();
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  return NextResponse.json({ sent: result.sent });
}
