#!/usr/bin/env bash
# Prove the backup_fs tests can fail. Runs them on the real src-tauri/src/backup_fs.rs, then on one
# planted defect at a time, and says which test caught each. A defect no test catches is a gap in the
# tests, and exits non-zero.
#
# The file logic takes a directory and needs only std, so it is built here as a crate of its own
# (serde's derive stripped from a copy) and needs no Tauri, no display, no webkit. The real file is
# never modified. Needs cargo on PATH.
#   OUT     scratch directory for the copy and the logs (default: a fresh temp directory)
#   TARGET  extra cargo flags, e.g. "--target x86_64-unknown-linux-musl" on a host with no C compiler
set -u
cd "$(dirname "$0")/.." || exit 1
SRC=src-tauri/src/backup_fs.rs
OUT=${OUT:-$(mktemp -d)}
TARGET=${TARGET:-}
CRATE="$OUT/crate"
mkdir -p "$CRATE/src"
export CARGO_TARGET_DIR="$OUT/target"

cat >"$CRATE/Cargo.toml" <<'TOML'
[package]
name = "backup-fs-mutants"
version = "0.0.0"
edition = "2021"
publish = false
[lib]
path = "src/lib.rs"
TOML

# The real file, minus the one dependency the tests do not need.
perl -0pe 's/use serde::Serialize;\n//; s/#\[derive\(Serialize, Clone\)\]/#[derive(Clone)]/' "$SRC" >"$OUT/backup_fs.orig.rs"
if grep -q serde "$OUT/backup_fs.orig.rs"; then echo "serde is still in the copy: update this script"; exit 1; fi
restore() { cp "$OUT/backup_fs.orig.rs" "$CRATE/src/lib.rs"; }

# shellcheck disable=SC2086 # TARGET is a list of cargo flags, split on purpose.
tests() { (cd "$CRATE" && cargo test -q --lib $TARGET >"$OUT/$1.log" 2>&1); }
failing() { grep -oE '^    tests::[a-z_0-9]+' "$OUT/$1.log" | sed 's/^ *tests:://' | sort -u | paste -sd, -; }

restore
if tests real; then
  echo "real code: $(grep -oE '[0-9]+ passed' "$OUT/real.log" | head -1)"
else
  echo "real code FAILED: $(failing real)  (log $OUT/real.log)"
  exit 1
fi

# name ~ what the defect is ~ text to find (first occurrence) ~ text to put there.
# Literal Rust, one mutant per line; "\n" stands for a newline; nothing here contains a "~".
MUTANTS=$(cat <<'LIST'
magic~writes bytes that are not a SQLite image~if bytes.len() < 16 || &bytes[..16] != SQLITE_MAGIC {~if false {
magic-short~indexes a header that is not there~bytes.len() < 16 || ~
slash~lets a name carry a slash~name.contains('/') || ~
backslash~lets a name carry a backslash~name.contains('\\') || ~
dotdot~lets a name carry ..~name.contains("..") || ~
nul~lets a name carry a NUL~ || name.contains('\0')~
prefix~accepts a name without the backup prefix~!name.starts_with(PREFIX) || !name.ends_with(EXT) {\n        return Err("unexpected~!name.ends_with(EXT) {\n        return Err("unexpected
ext~accepts a name without the .db extension~!name.starts_with(PREFIX) || !name.ends_with(EXT) {\n        return Err("unexpected~!name.starts_with(PREFIX) {\n        return Err("unexpected
write-unguarded~writes without checking the name~    safe_name(name)?;\n    if bytes.len()~    if bytes.len()
read-unguarded~reads without checking the name~    safe_name(name)?;\n    std::fs::read(~    std::fs::read(
delete-unguarded~deletes without checking the name~    safe_name(name)?;\n    std::fs::remove_file(~    std::fs::remove_file(
misplaced~writes outside the backups directory~let final_path = dir.join(name);~let final_path = dir.join("..").join(name);
atomic~copies instead of renaming, leaving the temp file~std::fs::rename(&tmp_path, &final_path)~std::fs::copy(&tmp_path, &final_path).map(|_| ())
sweep~stops sweeping stale temp files~let _ = std::fs::remove_file(&path);\n            continue;~continue;
foreign~lists files that are not backups~if !name.starts_with(PREFIX) || !name.ends_with(EXT) {\n        return None;~if false {\n        return None;
unsorted~lists in directory order~    out.sort_by(|a, b| a.name.cmp(&b.name));\n~
sorted-backwards~lists newest first~a.name.cmp(&b.name)~b.name.cmp(&a.name)
prune-newest~prunes the newest instead of the oldest~infos.drain(..cutoff)~infos.drain(keep..)
prune-extra~keeps one more than asked~let cutoff = infos.len() - keep;~let cutoff = infos.len() - keep - 1;
delete-nothing~reports a delete and removes nothing~std::fs::remove_file(dir.join(name)).map_err(|e| e.to_string())~Ok(())
LIST
)
status=0
while IFS='~' read -r name what find repl; do
  restore
  FIND=${find//\\n/$'\n'} REPL=${repl//\\n/$'\n'} \
    perl -0pi -e 's/\Q$ENV{FIND}\E/$ENV{REPL}/' "$CRATE/src/lib.rs"
  if cmp -s "$CRATE/src/lib.rs" "$OUT/backup_fs.orig.rs"; then
    echo "mutant $name: DID NOT APPLY"; status=1; continue
  fi
  if tests "$name"; then
    echo "mutant $name ($what): SURVIVED - no test caught it"; status=1
  elif [ -n "$(failing "$name")" ]; then
    echo "mutant $name ($what): caught by $(failing "$name")"
  else
    echo "mutant $name ($what): did not build - fix the mutant (log $OUT/$name.log)"; status=1
  fi
done <<<"$MUTANTS"
exit $status
