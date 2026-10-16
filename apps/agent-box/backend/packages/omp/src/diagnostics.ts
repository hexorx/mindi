/** Bounded, line-oriented operator diagnostics; never copied into run errors. */
export class DiagnosticTail {
  private line = "";
  private discarding = false;
  private lines: string[] = [];
  private readonly secrets: string[];
  constructor(env: NodeJS.ProcessEnv) {
    this.secrets = Object.entries(env)
      .filter(
        ([key, value]) =>
          /key|token|secret|password|cookie|credential/i.test(key) &&
          value &&
          value.length >= 4,
      )
      .map(([, value]) => value!);
  }
  private append(line: string) {
    if (
      /authorization|bearer|api[_ -]?key|token|secret|password|credential|cookie|sk-[a-z0-9]/i.test(
        line,
      )
    )
      line = "[redacted sensitive diagnostic]";
    else
      for (const secret of this.secrets)
        line = line.split(secret).join("[redacted]");
    this.lines.push(line);
    while (Buffer.byteLength(this.lines.join("\n")) > 4096) this.lines.shift();
  }
  read(chunk: Buffer) {
    for (const character of chunk.toString("utf8")) {
      if (character === "\n") {
        this.append(
          this.discarding ? "[oversized diagnostic omitted]" : this.line,
        );
        this.line = "";
        this.discarding = false;
      } else if (!this.discarding) {
        this.line += character;
        if (Buffer.byteLength(this.line) > 4096) {
          this.line = "";
          this.discarding = true;
        }
      }
    }
  }
  finish(): string {
    if (this.line || this.discarding)
      this.append(
        this.discarding ? "[oversized diagnostic omitted]" : this.line,
      );
    this.line = "";
    this.discarding = false;
    return this.lines.join("\n");
  }
}
