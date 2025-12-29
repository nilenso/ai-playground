import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'

const app = new Hono()

app.get('/', (c) => {
  return c.html(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lenso2 - Camera & Microphone Access</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    .container {
      background: white;
      border-radius: 20px;
      padding: 40px;
      max-width: 600px;
      width: 90%;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
      text-align: center;
    }
    
    h1 {
      color: #1a1a2e;
      font-size: 2.5rem;
      margin-bottom: 10px;
    }
    
    .subtitle {
      color: #666;
      margin-bottom: 30px;
      font-size: 1.1rem;
    }
    
    .video-container {
      background: #1a1a2e;
      border-radius: 12px;
      overflow: hidden;
      margin-bottom: 30px;
      aspect-ratio: 16/9;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    #video {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: none;
    }
    
    .placeholder {
      color: #666;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
    }
    
    .placeholder svg {
      width: 60px;
      height: 60px;
      opacity: 0.5;
    }
    
    .btn {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      padding: 15px 40px;
      font-size: 1.1rem;
      border-radius: 50px;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    
    .btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 10px 20px rgba(102, 126, 234, 0.4);
    }
    
    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }
    
    .status {
      margin-top: 20px;
      padding: 15px;
      border-radius: 10px;
      display: none;
    }
    
    .status.success {
      display: block;
      background: #d4edda;
      color: #155724;
    }
    
    .status.error {
      display: block;
      background: #f8d7da;
      color: #721c24;
    }
    
    .permissions-list {
      display: flex;
      justify-content: center;
      gap: 30px;
      margin: 20px 0;
    }
    
    .permission-item {
      display: flex;
      align-items: center;
      gap: 8px;
      color: #666;
    }
    
    .permission-item svg {
      width: 24px;
      height: 24px;
    }
    
    .permission-item.granted svg {
      color: #28a745;
    }
    
    .permission-item.denied svg {
      color: #dc3545;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎥 Lenso2</h1>
    <p class="subtitle">Grant camera and microphone access to get started</p>
    
    <div class="video-container">
      <video id="video" autoplay playsinline muted></video>
      <div class="placeholder" id="placeholder">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
        <span>Camera preview will appear here</span>
      </div>
    </div>
    
    <div class="permissions-list">
      <div class="permission-item" id="camera-status">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
        <span>Camera</span>
      </div>
      <div class="permission-item" id="mic-status">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
        </svg>
        <span>Microphone</span>
      </div>
    </div>
    
    <button class="btn" id="requestBtn">Enable Camera & Microphone</button>
    
    <div class="status" id="status"></div>
  </div>

  <script>
    const video = document.getElementById('video');
    const placeholder = document.getElementById('placeholder');
    const requestBtn = document.getElementById('requestBtn');
    const statusDiv = document.getElementById('status');
    const cameraStatus = document.getElementById('camera-status');
    const micStatus = document.getElementById('mic-status');

    async function requestPermissions() {
      requestBtn.disabled = true;
      requestBtn.textContent = 'Requesting access...';
      
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true
        });
        
        // Show video preview
        video.srcObject = stream;
        video.style.display = 'block';
        placeholder.style.display = 'none';
        
        // Update status
        cameraStatus.classList.add('granted');
        micStatus.classList.add('granted');
        
        statusDiv.className = 'status success';
        statusDiv.textContent = '✓ Camera and microphone access granted!';
        
        requestBtn.textContent = 'Access Granted';
        
      } catch (error) {
        console.error('Permission error:', error);
        
        statusDiv.className = 'status error';
        
        if (error.name === 'NotAllowedError') {
          statusDiv.textContent = '✗ Permission denied. Please allow access in your browser settings.';
        } else if (error.name === 'NotFoundError') {
          statusDiv.textContent = '✗ No camera or microphone found on this device.';
        } else {
          statusDiv.textContent = '✗ Error: ' + error.message;
        }
        
        cameraStatus.classList.add('denied');
        micStatus.classList.add('denied');
        
        requestBtn.disabled = false;
        requestBtn.textContent = 'Try Again';
      }
    }

    requestBtn.addEventListener('click', requestPermissions);
  </script>
</body>
</html>
  `)
})

export default app
