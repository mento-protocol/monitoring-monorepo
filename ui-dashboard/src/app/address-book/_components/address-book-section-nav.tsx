import Link from "next/link";

type AddressBookSection = "addresses" | "entities";

const SECTIONS: ReadonlyArray<{
  id: AddressBookSection;
  href: string;
  label: string;
}> = [
  { id: "addresses", href: "/address-book", label: "Addresses" },
  { id: "entities", href: "/address-book/entities", label: "Entities" },
];

export function AddressBookSectionNav({
  active,
}: {
  active: AddressBookSection;
}) {
  return (
    <nav
      aria-label="Address book sections"
      className="flex min-w-0 gap-1 overflow-x-auto border-b border-slate-800"
    >
      {SECTIONS.map((section) => (
        <Link
          key={section.id}
          href={section.href}
          aria-current={active === section.id ? "page" : undefined}
          className={`px-2 py-2 text-sm font-medium transition-colors sm:px-4 ${
            active === section.id
              ? "border-b-2 border-indigo-500 text-white"
              : "text-slate-400 hover:text-slate-200"
          }`}
        >
          {section.label}
        </Link>
      ))}
    </nav>
  );
}
