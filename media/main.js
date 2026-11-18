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
} else if (report.initialMode === 'struct-view')
  switchTab('tab-struct-view');
else if (report.initialMode === 'record-trace')
  switchTab('tab-record-trace');
else if (report.initialMode === 'protocol-analyze')
  switchTab('tab-protocol-analyze');
else
  switchTab('tab-registers');
})(window.Binsight);
