export interface ParsedCookie {
  name: string;
  value: string;
  options: {
    path: string;
    domain?: string;
    maxAge?: number;
    expires?: Date;
    httpOnly: boolean;
    secure: boolean;
    sameSite?: "lax" | "strict" | "none";
  };
}

/** Parses a Set-Cookie header value; the value is kept as sent (already encoded). */
export function parseSetCookie(header: string): ParsedCookie | null {
  const [pair, ...attributes] = header.split(";").map((part) => part.trim());
  const eq = pair?.indexOf("=") ?? -1;
  if (!pair || eq <= 0) return null;
  const cookie: ParsedCookie = { name: pair.slice(0, eq), value: pair.slice(eq + 1), options: { path: "/", httpOnly: false, secure: false } };
  for (const attribute of attributes) {
    const [rawKey = "", ...rest] = attribute.split("=");
    const key = rawKey.toLowerCase();
    const value = rest.join("=");
    if (key === "path") cookie.options.path = value || "/";
    else if (key === "domain") cookie.options.domain = value;
    else if (key === "max-age" && /^-?\d+$/.test(value)) cookie.options.maxAge = Number(value);
    else if (key === "expires" && !Number.isNaN(Date.parse(value))) cookie.options.expires = new Date(value);
    else if (key === "httponly") cookie.options.httpOnly = true;
    else if (key === "secure") cookie.options.secure = true;
    else if (key === "samesite" && ["lax", "strict", "none"].includes(value.toLowerCase())) {
      cookie.options.sameSite = value.toLowerCase() as "lax" | "strict" | "none";
    }
  }
  return cookie;
}
