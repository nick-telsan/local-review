import type { CSSProperties } from "react";
import type { Token } from "./highlight.ts";

/** A line of highlighted code. `style.css` gives each token its light or dark theme's color. */
export function Tokens({ tokens }: { tokens: Token[] }) {
  return tokens.map((t) => (
    <span key={t.offset} className="tok" style={t.style as CSSProperties}>
      {t.text}
    </span>
  ));
}
