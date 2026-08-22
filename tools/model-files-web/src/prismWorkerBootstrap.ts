(globalThis as {
  Prism?: { disableWorkerMessageHandler?: boolean }
}).Prism = { disableWorkerMessageHandler: true }
