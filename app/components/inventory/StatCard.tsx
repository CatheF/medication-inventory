const COLORS = {
  blue: "bg-blue-50 border-blue-200 text-blue-800",
  amber: "bg-amber-50 border-amber-200 text-amber-800",
  green: "bg-green-50 border-green-200 text-green-800",
} as const;

/**
 * One summary number. `value` is null while the inventory is loading or could not be loaded: it then shows an
 * em dash, never 0 (a zero would read as "the inventory is empty").
 */
export function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number | null;
  color: keyof typeof COLORS;
}) {
  return (
    <div className={`rounded-xl border p-4 ${COLORS[color]}`}>
      <p className="text-2xl font-bold">
        {value === null ? (
          <>
            <span aria-hidden="true">—</span>
            <span className="sr-only">not available</span>
          </>
        ) : (
          value
        )}
      </p>
      <p className="mt-0.5 text-sm">{label}</p>
    </div>
  );
}
