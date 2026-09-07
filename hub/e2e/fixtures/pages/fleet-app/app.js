// Fixture app for TP-pages-033: proves scripts execute inside the sandbox AND
// that the sandbox holds — reaching the hub shell's document must throw.
document.getElementById('status').textContent = 'script ran';
let verdict = 'NOT isolated';
try {
  void window.parent.document; // opaque origin => cross-origin => throws
} catch {
  verdict = 'isolated';
}
document.getElementById('isolation').textContent = verdict;
