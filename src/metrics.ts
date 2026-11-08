export class Metrics {
  private readonly counters = new Map<string, number>();

  inc(name: string, labels: Record<string, string> = {}): void {
    const pairs = Object.entries(labels).map(([key, value]) => `${key}="${value.replace(/["\\\n]/g, "_")}"`);
    const series = pairs.length ? `${name}{${pairs.join(",")}}` : name;
    this.counters.set(series, (this.counters.get(series) ?? 0) + 1);
  }

  get(series: string): number {
    return this.counters.get(series) ?? 0;
  }

  render(gauges: Record<string, number>): string {
    const lines = [...this.counters].map(([series, value]) => `${series} ${value}`);
    for (const [name, value] of Object.entries(gauges)) lines.push(`${name} ${value}`);
    return `${lines.sort().join("\n")}\n`;
  }
}
