//! diskscan.rs — local disk Filelight walk.
//!
//! Recursively measures directories for the local-disk sunburst and the
//! "what will this plan back up" preview. Exclusion-profile patterns are
//! honored so the scan shows what a backup would actually see.
//!
//! Pattern dialect (gitignore-ish, matching the default profile):
//!   `~/x/**`        — under home
//!   `**/name/**`    — a dir/file named `name` anywhere
//!   `**/*.ext`      — suffix match anywhere
//!   `**`            — anywhere separator
//! Depth cap keeps scans bounded; size is bytes total.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

const MAX_DEPTH: usize = 8;
const MAX_ENTRIES: usize = 12;

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// Simple glob match: `**` crosses separators, `*` stays within a segment.
/// `~` at the head expands to home.
pub fn pattern_matches(pattern: &str, path: &Path) -> bool {
    let pat = pattern.replace('~', &home().to_string_lossy());
    let p = path.to_string_lossy();
    glob_match(&pat, &p)
}

fn glob_match(pat: &str, s: &str) -> bool {
    // Split on ** — segments between are joined by any depth.
    let parts: Vec<&str> = pat.split("**").collect();
    if parts.len() == 1 {
        return seg_match(pat, s);
    }
    // First part must match a prefix, last a suffix; middles just need to
    // appear in order.
    let mut rest = s;
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        let mut found = false;
        // Try aligning `part` at every path-segment boundary in `rest`.
        let mut idx = 0;
        while idx <= rest.len() {
            let tail = &rest[idx..];
            let ok = if i == parts.len() - 1 {
                // Last chunk: match as suffix-with-** (prefix of tail works
                // since ** swallowed the tail already).
                seg_prefix_match(part, tail) || seg_match(part, tail)
            } else {
                seg_prefix_match(part, tail)
            };
            if ok {
                // Advance rest past this match point for the next part.
                rest = &rest[idx + part.len().min(tail.len())..];
                found = true;
                break;
            }
            match rest[idx..].find('/') {
                Some(off) => idx += off + 1,
                None => break,
            }
        }
        if !found && !(i == parts.len() - 1 && seg_match(part, "")) {
            return false;
        }
    }
    true
}

/// `part` matches the beginning of `s` up to a `/` boundary.
fn seg_prefix_match(part: &str, s: &str) -> bool {
    let mut pi = part.chars().peekable();
    let mut si = s.chars().peekable();
    while let (Some(&pc), Some(&sc)) = (pi.peek(), si.peek()) {
        if pc == sc {
            pi.next();
            si.next();
        } else if pc == '*' {
            pi.next();
            while let Some(&c) = si.peek() {
                if c == '/' {
                    break;
                }
                si.next();
            }
        } else {
            return false;
        }
    }
    // Consumed all of `part` → prefix hit.
    pi.peek().is_none()
}

/// Whole-string single-star match (no `**` in `pat`).
fn seg_match(pat: &str, s: &str) -> bool {
    if pat.is_empty() {
        return true;
    }
    let psegs: Vec<&str> = pat.split('/').filter(|x| !x.is_empty()).collect();
    let ssegs: Vec<&str> = s.split('/').filter(|x| !x.is_empty()).collect();
    if psegs.len() != ssegs.len() {
        return false;
    }
    psegs.iter().zip(ssegs.iter()).all(|(p, s)| star_match(p, s))
}

fn star_match(pat: &str, s: &str) -> bool {
    // One-level `*` glob, backtracking-free via iterative two-pointer.
    let (p, s) = (pat.as_bytes(), s.as_bytes());
    let (mut pi, mut si, mut star, mut mark) = (0usize, 0usize, usize::MAX, 0usize);
    while si < s.len() {
        if pi < p.len() && (p[pi] == s[si] || p[pi] == b'?') {
            pi += 1;
            si += 1;
        } else if pi < p.len() && p[pi] == b'*' {
            star = pi;
            mark = si;
            pi += 1;
        } else if star != usize::MAX {
            pi = star + 1;
            mark += 1;
            si = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == b'*' {
        pi += 1;
    }
    pi == p.len()
}

#[derive(Debug)]
struct Node {
    name: String,
    path: String,
    size: u64,
    children: Vec<Node>,
}

fn excluded(path: &Path, patterns: &[String]) -> bool {
    patterns.iter().any(|p| pattern_matches(p, path))
}

fn walk(dir: &Path, depth: usize, patterns: &[String]) -> Option<Node> {
    if depth > MAX_DEPTH || excluded(dir, patterns) {
        return None;
    }
    let mut node = Node {
        name: dir
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| dir.display().to_string()),
        path: dir.display().to_string(),
        size: 0,
        children: vec![],
    };
    let rd = std::fs::read_dir(dir).ok()?;
    for e in rd.flatten() {
        let p = e.path();
        let Ok(md) = e.metadata() else { continue };
        if md.is_symlink() {
            continue;
        }
        if md.is_dir() {
            if let Some(c) = walk(&p, depth + 1, patterns) {
                node.size += c.size;
                node.children.push(c);
            }
        } else if md.is_file() {
            node.size = node.size.saturating_add(md.len());
        }
    }
    node.children.sort_by(|a, b| b.size.cmp(&a.size));
    node.children.truncate(MAX_ENTRIES);
    Some(node)
}

fn to_json(n: &Node) -> Value {
    json!({
        "name": n.name,
        "path": n.path,
        "size": n.size,
        "children": n.children.iter().map(to_json).collect::<Vec<_>>(),
    })
}

/// Public entry — `paths` roots scanned with `patterns` exclusions.
pub fn scan(paths: &[String], patterns: &[String]) -> Value {
    let mut roots: Vec<Node> = Vec::new();
    let mut total = 0u64;
    for p in paths {
        let path = Path::new(p);
        if let Some(n) = walk(path, 0, patterns) {
            total += n.size;
            roots.push(n);
        }
    }
    roots.sort_by(|a, b| b.size.cmp(&a.size));
    roots.truncate(MAX_ENTRIES);
    json!({
        "total": total,
        "roots": roots.iter().map(to_json).collect::<Vec<_>>(),
    })
}
