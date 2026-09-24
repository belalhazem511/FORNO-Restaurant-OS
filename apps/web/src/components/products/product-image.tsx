"use client";

import { useState } from "react";

export function ProductImage({ imageKey, alt, className = "" }: { imageKey?: string | null; alt: string; className?: string }) {
  const [failedKey, setFailedKey] = useState<string | null>(null);
  if (!imageKey || failedKey === imageKey) {
    return <div className={`flex items-center justify-center bg-muted text-muted-foreground ${className}`} role="img" aria-label={alt}>🍽️</div>;
  }
  return <img src={`/media/${imageKey.split("/").map(encodeURIComponent).join("/")}`} alt={alt} className={className} onError={() => setFailedKey(imageKey)} />;
}
