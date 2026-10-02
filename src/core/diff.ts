export type LineKind = "add" | "del" | "context";

export interface DiffLine {
  kind: LineKind;
  /** Line number in the new file (undefined for deletions). */
  newLine?: number;
  /** Line number in the old file (undefined for additions). */
  oldLine?: number;
  text: string;
}

export interface Hunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface FileDiff {
  path: string;
  oldPath?: string;
  status: FileStatus;
  binary: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

function stripPrefix(p: string): string {
  const unquoted = p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;
  return unquoted.replace(/^[ab]\//, "");
}

export function parseDiff(diffText: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | undefined;
  let hunk: Hunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of diffText.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git (\S+|"[^"]+") (\S+|"[^"]+")$/.exec(line);
      file = {
        path: m?.[2] ? stripPrefix(m[2]) : "",
        status: "modified",
        binary: false,
        hunks: [],
      };
      if (m?.[1] && m[2] && stripPrefix(m[1]) !== stripPrefix(m[2])) file.oldPath = stripPrefix(m[1]);
      files.push(file);
      hunk = undefined;
      continue;
    }
    if (!file) continue;

    if (!hunk) {
      if (line.startsWith("new file mode")) file.status = "added";
      else if (line.startsWith("deleted file mode")) file.status = "deleted";
      else if (line.startsWith("rename from ")) {
        file.status = "renamed";
        file.oldPath = line.slice("rename from ".length);
      } else if (line.startsWith("rename to ")) {
        file.status = "renamed";
        file.path = line.slice("rename to ".length);
      } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) file.binary = true;
      else if (line.startsWith("+++ ")) {
        const p = line.slice(4).trim();
        if (p !== "/dev/null") file.path = stripPrefix(p);
      } else if (line.startsWith("--- ")) {
        const p = line.slice(4).trim();
        if (p === "/dev/null") file.status = "added";
      }
    }

    const h = HUNK_RE.exec(line);
    if (h?.[1] && h[2]) {
      oldLine = Number(h[1]);
      newLine = Number(h[2]);
      hunk = { header: line, oldStart: oldLine, newStart: newLine, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;

    if (line.startsWith("+")) {
      hunk.lines.push({ kind: "add", newLine: newLine++, text: line.slice(1) });
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "del", oldLine: oldLine++, text: line.slice(1) });
    } else if (line.startsWith(" ")) {
      hunk.lines.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, text: line.slice(1) });
    }
  }
  return files;
}

/** Lines on the RIGHT side of the diff that GitHub accepts review comments on. */
export function commentableLines(file: FileDiff): Set<number> {
  const set = new Set<number>();
  for (const h of file.hunks) for (const l of h.lines) if (l.newLine !== undefined) set.add(l.newLine);
  return set;
}

export function addedLines(file: FileDiff): DiffLine[] {
  return file.hunks.flatMap((h) => h.lines.filter((l) => l.kind === "add"));
}

export function renderHunk(h: Hunk): string {
  const out = [h.header];
  for (const l of h.lines) {
    const num = l.newLine !== undefined ? String(l.newLine).padStart(5) : "     ";
    const marker = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
    out.push(`${num} ${marker}${l.text}`);
  }
  return out.join("\n");
}

export function renderFileHeader(file: FileDiff): string {
  const rename = file.status === "renamed" && file.oldPath ? ` (renamed from ${file.oldPath})` : "";
  return `### File: ${file.path}\nStatus: ${file.status}${rename}`;
}
