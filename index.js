const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

// 环境变量设置
const UUID = process.env.UUID || '86391f6e-87ca-4665-8445-6a8d413c7fa9';
const ARGO_AUTH = process.env.ARGO_AUTH || '';
const CFIP = process.env.CFIP || 'www.visa.com.tw';
const NAME = process.env.NAME || 'app.koyeb.com';
const ARGO_PORT = process.env.ARGO_PORT || '443';
const CFPORT = process.env.CFPORT || '443';
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || '';
const FILE_PATH = process.env.FILE_PATH || 'world';
const SING_BOX_URL = "https://raw.githubusercontent.com/weishaoaai/sssss/main/sing-box";
const CLOUDFLARED_URL = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64";

// 创建目录
fs.mkdirSync(FILE_PATH, { recursive: true });
process.chdir(FILE_PATH);

// 清理旧文件
try {
  fs.unlinkSync('boot.log');
  fs.unlinkSync('tunnel.json');
  fs.unlinkSync('tunnel.yml');
} catch (e) {}

// 下载文件函数
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, response => {
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', err => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

// 下载并设置可执行权限
async function setupFiles() {
  await downloadFile(SING_BOX_URL, '1');
  await downloadFile(CLOUDFLARED_URL, '2');
  
  // 设置可执行权限
  fs.chmodSync('1', 0o755);
  fs.chmodSync('2', 0o755);
}

// 写入配置文件
function writeConfig() {
  const config = {
    "log": {
        "disabled": true,
        "level": "info",
        "timestamp": true
    },
    "dns": {
        "servers": [
        {
          "tag": "google",
          "address": "tls://8.8.8.8"
        }
      ]
    },
    "inbounds": [
    {
      "tag": "vmess-ws-in",
      "type": "vmess",
      "listen": "::",
      "listen_port": ARGO_PORT,
        "users": [
        {
          "uuid": UUID
        }
      ],
      "transport": {
        "type": "ws",
        "path": "/king",
        "early_data_header_name": "Sec-WebSocket-Protocol"
      }
    }
   ],
  "outbounds": [
    {
      "type": "direct",
      "tag": "direct"
    },
    {
      "type": "block",
      "tag": "block"
    }
  ],
  "route": {
    "final": "direct"
  }
  };
  
  fs.writeFileSync('config.json', JSON.stringify(config, null, 2));
}

// 设置Cloudflare隧道配置
function setupTunnel() {
  if (ARGO_AUTH && ARGO_DOMAIN) {
    if (ARGO_AUTH.includes('TunnelSecret')) {
      fs.writeFileSync('tunnel.json', ARGO_AUTH);
      
      // 提取隧道ID
      const match = ARGO_AUTH.match(/"id":"([^"]+)"/);
      const tunnelId = match ? match[1] : 'unknown';
      
      const tunnelConfig = `tunnel: ${tunnelId}
credentials-file: tunnel.json
protocol: http2

ingress:
  - hostname: ${ARGO_DOMAIN}
    service: http://localhost:${ARGO_PORT}
    originRequest:
      noTLSVerify: true
  - service: http_status:404`;
      
      fs.writeFileSync('tunnel.yml', tunnelConfig);
    }
  }
}

// 启动服务
async function startServices() {
  return new Promise((resolve, reject) => {
    // 启动sing-box
    const singBoxProcess = exec('./1 run -c config.json', (error, stdout, stderr) => {
      if (error) {
        console.error(`sing-box error: ${error.message}`);
        reject(error);
      }
    });
    
    // 检查sing-box是否启动成功
    setTimeout(() => {
      try {
        execSync('pgrep -f "./1 run"');
        console.log('sing-box started successfully');
        
        // 启动cloudflared
        let cloudflaredCommand;
        if (ARGO_AUTH && ARGO_DOMAIN) {
          if (ARGO_AUTH.includes('TunnelSecret')) {
            cloudflaredCommand = `./2 tunnel --edge-ip-version auto --config tunnel.yml run`;
          } else {
            cloudflaredCommand = `./2 tunnel --edge-ip-version auto --no-autoupdate --protocol http2 run --token "${ARGO_AUTH}"`;
          }
        } else {
          cloudflaredCommand = `./2 tunnel --edge-ip-version auto --no-autoupdate --protocol http2 --logfile boot.log --loglevel info --url http://localhost:${ARGO_PORT}`;
        }
        
        const cloudflaredProcess = exec(cloudflaredCommand, (error, stdout, stderr) => {
          if (error) {
            console.error(`cloudflared error: ${error.message}`);
            if (fs.existsSync('boot.log')) {
              console.log(fs.readFileSync('boot.log', 'utf8'));
            }
            reject(error);
          }
        });
        
        // 检查cloudflared是否启动成功
        setTimeout(() => {
          try {
            execSync('pgrep -f "./2 tunnel"');
            console.log('cloudflared started successfully');
            resolve();
          } catch (e) {
            console.error('cloudflared failed to start');
            if (fs.existsSync('boot.log')) {
              console.log(fs.readFileSync('boot.log', 'utf8'));
            }
            reject(new Error('cloudflared failed to start'));
          }
        }, 2000);
        
      } catch (e) {
        console.error('sing-box failed to start');
        reject(new Error('sing-box failed to start'));
      }
    }, 2000);
    
    // 捕获退出信号，清理进程
    process.on('SIGINT', () => {
      console.log('\nStopping services...');
      try {
        execSync('pkill -f "./1 run"');
        execSync('pkill -f "./2 tunnel"');
        console.log('Services stopped');
      } catch (e) {}
      process.exit(0);
    });
  });
}

// 获取Argo域名
function getArgoDomain() {
  if (ARGO_DOMAIN) {
    return ARGO_DOMAIN;
  } else {
    let retry = 0;
    const maxRetries = 10;
    
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        retry++;
        if (retry > maxRetries) {
          clearInterval(interval);
          resolve('unknown.trycloudflare.com');
          return;
        }
        
        if (fs.existsSync('boot.log')) {
          const logContent = fs.readFileSync('boot.log', 'utf8');
          const match = logContent.match(/https:\/\/([^/]*trycloudflare\.com)/);
          if (match) {
            clearInterval(interval);
            resolve(match[1]);
          }
        }
      }, 2000);
    });
  }
}

// 主函数
async function main() {
  try {
    await setupFiles();
    writeConfig();
    setupTunnel();
    await startServices();
    const argodomain = await getArgoDomain();
    
    const VMESS = { 
      "v": "2", 
      "ps": NAME, 
      "add": CFIP, 
      "port": CFPORT, 
      "id": UUID, 
      "aid": "0", 
      "scy": "none", 
      "net": "ws", 
      "type": "none", 
      "host": argodomain, 
      "path": "/king?ed=2048", 
      "tls": "tls", 
      "sni": argodomain, 
      "alpn": "", 
      "fp": ""
    };
    
    const vmessBase64 = Buffer.from(JSON.stringify(VMESS)).toString('base64');
    fs.writeFileSync('boot.log', `vmess://${vmessBase64}`);
    
    console.log("hello");
    
    // 保持进程运行
    await new Promise(() => {});
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
