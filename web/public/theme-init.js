// Theme before first paint (no flash): Legacy unless Classic was chosen on this device.
// External file (not inline) so the CSP can forbid inline scripts.
(function () {
  try {
    var t = localStorage.getItem("checklah-theme");
    document.documentElement.dataset.theme = t === "classic" ? "classic" : "legacy";
  } catch (e) {
    document.documentElement.dataset.theme = "legacy";
  }
})();
