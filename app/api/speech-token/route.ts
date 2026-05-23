import { NextResponse } from "next/server";

let cachedToken: string | null = null;
let cachedTokenExpiry = 0;
let tokenRequestPromise: Promise<string> | null = null;
const TOKEN_CACHE_DURATION_MS = 9 * 60 * 1000;

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

  if (cachedToken && Date.now() < cachedTokenExpiry) {
    return NextResponse.json({ token: cachedToken, region: speechRegion });
  }

  if (!tokenRequestPromise) {
    tokenRequestPromise = (async () => {
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
        throw new Error("Failed to issue Azure Speech token.");
      }

      return tokenResponse.text();
    })().finally(() => {
      tokenRequestPromise = null;
    });
  }

  let token: string;
  try {
    token = await tokenRequestPromise;
  } catch {
    return NextResponse.json(
      {
        error: "Failed to issue Azure Speech token.",
      },
      { status: 502 },
    );
  }
  cachedToken = token;
  cachedTokenExpiry = Date.now() + TOKEN_CACHE_DURATION_MS;

  return NextResponse.json({ token, region: speechRegion });
}
