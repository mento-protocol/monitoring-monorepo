import { signIn } from "@/auth";

export function sanitizeCallbackUrl(raw?: string): string {
  const DEFAULT = "/address-book";
  if (!raw) return DEFAULT;

  // Raw-level checks: things URL parsing would silently strip or normalize
  // past us. Tab/CR/LF are quietly removed by WHATWG URL parsing, null bytes
  // can masquerade as valid pathname chars, and leading whitespace evades
  // the `startsWith("/")` gate below.
  // eslint-disable-next-line no-control-regex -- blocking control-char smuggling is the whole point here
  if (/[\x00-\x1f\x7f-\x9f]/.test(raw)) return DEFAULT;
  if (!raw.startsWith("/")) return DEFAULT;
  if (raw.startsWith("//")) return DEFAULT;

  // Parse against a dummy origin and confirm the result stays same-origin.
  // Backslash in a "special" scheme's path is normalized to `/`, so
  // `/\evil.com` reparents onto evil.com — the origin check catches it.
  try {
    const parsed = new URL(raw, "https://sanitize.invalid");
    if (parsed.origin !== "https://sanitize.invalid") return DEFAULT;
    const { pathname } = parsed;
    if (!pathname.startsWith("/") || pathname.startsWith("//")) return DEFAULT;
    // Path-only checks. These vectors (backslash, user-info `@`, percent-
    // encoded slash/backslash, and the same double-encoded) only matter in
    // the pathname — routers may decode them into `/` there and produce
    // `//evil.com`. Query strings legitimately carry these chars (email
    // filters like `?owner=alice@mentolabs.xyz`, URL-shaped params), so
    // restricting the check to pathname avoids breaking real same-origin
    // callbacks.
    if (/[\\@]/.test(pathname)) return DEFAULT;
    if (/%(?:2[fF]|5[cC]|25(?:2[fF]|5[cC]))/.test(pathname)) return DEFAULT;
  } catch {
    return DEFAULT;
  }

  return raw;
}

type Props = {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
};

export default async function SignInPage({ searchParams }: Props) {
  const { callbackUrl, error } = await searchParams;
  const redirectTo = sanitizeCallbackUrl(callbackUrl);

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-sm rounded-xl border border-slate-800 bg-slate-900 p-8 text-center">
        <h1 className="text-xl font-bold text-white mb-2">Sign in</h1>
        <p className="text-sm text-slate-400 mb-6">
          Restricted to <span className="text-slate-300">@mentolabs.xyz</span>{" "}
          accounts
        </p>
        {error === "AccessDenied" && (
          <p className="mb-4 rounded-lg border border-red-800 bg-red-950 px-3 py-2 text-xs text-red-300">
            Only @mentolabs.xyz accounts are allowed.
          </p>
        )}
        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo });
          }}
        >
          <button
            type="submit"
            className="w-full rounded-lg bg-white px-4 py-3 text-sm font-medium text-slate-900 hover:bg-slate-100 transition-colors flex items-center justify-center gap-3"
          >
            <GoogleIcon />
            Continue with Google
          </button>
        </form>
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}
