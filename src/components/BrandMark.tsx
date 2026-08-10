// CFERP brand lockup for the top header bar: the Candor "CF" logo on a small
// white chip (the logo art has a white ground, so the chip reads as an app
// badge against the maroon header) plus the "CFERP" wordmark. Replaces the
// former AWS "aws" wordmark across every page header.

export function BrandMark() {
  return (
    <span className="flex items-center gap-2 select-none">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/candor_logo.jpg"
        alt="CFERP"
        className="h-6 w-6 rounded-[3px] bg-white object-contain p-[1px]"
      />
      <span className="text-white font-bold tracking-tight text-[17px]">
        CFERP
      </span>
    </span>
  );
}
