export async function saveChartImages(samples, summary) {
  const response = await fetch("/api/export-charts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ samples, summary }),
  });

  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    throw new Error(details.error || `export failed: ${response.status}`);
  }
  return response.json();
}
