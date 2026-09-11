// QA-only output selection. Labels create new receipts; they never replace one.
export function receiptArguments(args) {
  const [directory, ...tail] = args;
  if (!/^out\/(?:(?:production|fault)-qa-[a-zA-Z0-9-]+|aligned-(?:linux|windows)-[0-9a-f]{7,40})$/.test(directory ?? ""))
    throw Error("Specify an owned candidate directory");
  const labels = tail.filter((item) => item.startsWith("--label="));
  if (labels.length > 1) throw Error("Specify at most one receipt label");
  const label = labels.length ? labels[0].slice("--label=".length) : "";
  if (labels.length && !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(label))
    throw Error("Invalid receipt label");
  const reports = tail.filter((item) => !item.startsWith("--label="));
  if (!reports.length || reports.some((item) => item.startsWith("--")))
    throw Error("Specify the executed JSON reports; unknown option rejected");
  return { directory, reports, suffix: label ? `-${label}` : "" };
}
