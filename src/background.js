chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'fetchImage') {
    fetch(request.url)
      .then(response => response.blob())
      .then(blob => {
        const reader = new FileReader();
        reader.onloadend = () => sendResponse({ base64: reader.result });
        reader.onerror = () => sendResponse({ error: 'FileReader error' });
        reader.readAsDataURL(blob);
      })
      .catch(error => sendResponse({ error: error.message }));
    
    return true; // Держим канал открытым для асинхронного ответа
  }
});