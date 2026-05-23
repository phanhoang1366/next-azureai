import { NextResponse } from "next/server";

export async function POST() {
  const speechKey = process.env.AZURE_SPEECH_KEY;
  const speechRegion = process.env.AZURE_SPEECH_REGION;

  if (!speechKey || !speechRegion) {
    return NextResponse.json(
      {
        error: "AZURE_SPEECH_KEY and AZURE_SPEECH_REGION must be configured.",
      },
      { status: 500 },
    );
  }

  const tokenResponse = await fetch(
    `https://${speechRegion}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
    {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": speechKey,
      },
      cache: "no-store",
    },
  );

  if (!tokenResponse.ok) {
    return NextResponse.json(
      {
        error: "Failed to issue Azure Speech token.",
      },
      { status: 502 },
    );
  }

  const token = await tokenResponse.text();

  return NextResponse.json({ token, region: speechRegion });
}
