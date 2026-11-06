"use client";

import { useState } from "react";
import Image from "next/image";

type ItemThumbProps = {
  name: string | null;
  photoUrl: string | null;
  /** Square size in pixels. */
  size?: 40 | 48 | 56;
  className?: string;
};

function initialsOf(name: string | null): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  const letters = words
    .slice(0, 2)
    .map((w) => Array.from(w).find((ch) => /[\p{L}\p{N}]/u.test(ch)) ?? "")
    .join("");
  return letters ? letters.toUpperCase() : "Rx";
}

/**
 * Small item picture. Pictures are optional: with no photo, or when the photo fails to load, a neutral
 * placeholder with the item's initials is shown so rows keep the same layout. The image is decorative
 * (the item name is always printed next to it), so it has an empty alt.
 */
export function ItemThumb({ name, photoUrl, size = 40, className = "" }: ItemThumbProps) {
  // Remember WHICH url failed (not just "failed") so a new photo url is tried again without an effect.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = Boolean(photoUrl) && failedUrl !== photoUrl;
  const dimension = { width: size, height: size };

  return (
    <div
      style={dimension}
      className={`relative shrink-0 overflow-hidden rounded-lg border border-gray-200 bg-gray-100 ${className}`}
    >
      {showImage && photoUrl ? (
        <Image
          src={photoUrl}
          alt=""
          fill
          sizes={`${size}px`}
          className="object-cover"
          unoptimized
          onError={() => setFailedUrl(photoUrl)}
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex h-full w-full items-center justify-center text-xs font-semibold tracking-wide text-gray-600 select-none"
        >
          {initialsOf(name)}
        </span>
      )}
    </div>
  );
}
