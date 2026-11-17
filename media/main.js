(function(B) {
const {report, switchTab, modes} = B;

Object.values(modes).forEach((m) => m.init && m.init());

window.addEventListener('message', (event) => {
  const msg = event.data;
  for (const m of Object.values(modes)) {
    if (m.handleMessage && m.handleMessage(msg)) return;
  }
});

const savedTab = B.getUiState?.().activeTab;
if (savedTab && document.getElementById(savedTab)) {
  switchTab(savedTab);
} else if (report.initialMode === 'struct-list')
  switchTab('tab-struct-list');
else if (report.initialMode === 'repeat-struct')
  switchTab('tab-repeat-struct');
else if (report.initialMode === 'protocol')
  switchTab('tab-protocol');
else
  switchTab('tab-segments');
})(window.Binsight);
