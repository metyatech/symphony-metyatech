import http from 'http';
import { spawn } from 'child_process';

function request(path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port: 3000,
        path,
        method,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode, data }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function runTest() {
  console.log("Starting symphony server...");
  const child = spawn('node', ['dist/cli.js', '--workflow', '../WORKFLOW.md'], { stdio: 'inherit' });

  // Make sure to kill child on exit
  process.on('exit', () => child.kill());
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  
  console.log("Waiting for server to start...");
  await new Promise(r => setTimeout(r, 4000)); // wait for symhpony to start
  try {
    const status = await request('/status');
    console.log('/status:', status);
    
    const state = await request('/state');
    console.log('/state:', state);
    
    const stopResponse = await request('/stop', 'POST');
    console.log('/stop:', stopResponse);

    console.log("Success!");
    child.kill();
    process.exit(0);
  } catch (err) {
    console.error("Test failed:", err);
    child.kill();
    process.exit(1);
  }
}

runTest();