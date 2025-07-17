const { execSync, exec } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const https = require('https');

// 环境变量设置
const UUID = process.env.UUID || '96ce5271-7a3b-455b-adb3-69772d34d34e';
const ARGO_AUTH = process.env.ARGO_AUTH || '';
const CFIP = process.env.CFIP || 'www.visa.com.tw';
const NAME = process.env.NAME || 'app.koyeb.com';
const ARGO_PORT = process.env.ARGO_PORT ? parseInt(process.env.ARGO_PORT, 10) : 8080;
const CFPORT = process.env.CFPORT ? parseInt(process.env.CFPORT, 10) : 443;
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || '';
const FILE_PATH = process.env.FILE_PATH || 'world';
const SING_BOX_URL = "https://raw.githubusercontent.com/weishaoaai/sssss/main/sing-box";
const CLOUDFLARED_URL = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64";

// 初始化 SELF_URL 为 null
let SELF_URL = null;

// HTTP 请求选项
const keepAliveOptions = {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  }
};

let lastSuccess = true;

console.log(`环境配置: ARGO_PORT=${ARGO_PORT} (类型: ${typeof ARGO_PORT}), CFPORT=${CFPORT} (类型: ${typeof CFPORT})`);

// 创建目录
fs.mkdirSync(FILE_PATH, { recursive: true });
process.chdir(FILE_PATH);

// 清理旧文件
try {
  fs.unlinkSync('boot.log');
  fs.unlinkSync('tunnel.json');
  fs.unlinkSync('tunnel.yml');
} catch (e) {}

// 下载文件函数（支持重定向）
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`开始下载: ${url}`);
    
    const handleResponse = (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        const redirectUrl = response.headers.location;
        console.log(`跟随重定向: ${redirectUrl}`);
        https.get(redirectUrl, handleResponse).on('error', reject);
        return;
      }
      
      if (response.statusCode !== 200) {
        reject(new Error(`下载失败，状态码: ${response.statusCode}`));
        return;
      }
      
      const file = fs.createWriteStream(dest);
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        console.log(`下载完成: ${dest}`);
        resolve();
      });
    };
    
    https.get(url, handleResponse).on('error', reject);
  });
}

// 下载并设置可执行权限
async function setupFiles() {
  await downloadFile(SING_BOX_URL, '1');
  await downloadFile(CLOUDFLARED_URL, '2');
  
  fs.chmodSync('1', 0o755);
  fs.chmodSync('2', 0o755);
}

// 写入配置文件
function writeConfig() {
  console.log('生成配置文件: config.json');
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
      "listen": "127.0.0.1",
      "listen_port": ARGO_PORT + 1,
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
  console.log(`配置文件已生成，listen_port=${config.inbounds[0].listen_port} (类型: ${typeof config.inbounds[0].listen_port})`);
}

// 设置Cloudflare隧道配置
function setupTunnel() {
  console.log('配置Cloudflare隧道...');
  if (ARGO_AUTH && ARGO_DOMAIN) {
    if (ARGO_AUTH.includes('TunnelSecret')) {
      fs.writeFileSync('tunnel.json', ARGO_AUTH);
      
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
      console.log(`隧道配置已生成，使用域名: ${ARGO_DOMAIN}`);
    } else {
      console.log('使用令牌认证方式配置隧道');
    }
  } else {
    console.log('未提供ARGO_AUTH和ARGO_DOMAIN，使用临时域名');
  }
}

// 隧道保活函数
function keepTunnelAlive() {
  if (!SELF_URL) {
    console.log('隧道链接未初始化，暂不执行保活');
    return;
  }

  const protocol = SELF_URL.startsWith('https') ? https : http;
  protocol.get(`${SELF_URL}/health`, keepAliveOptions, (res) => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      if (!lastSuccess) {
        console.log(`隧道保活成功: ${SELF_URL}/health`);
        lastSuccess = true;
      }
    } else {
      console.log(`隧道保活失败，状态码: ${res.statusCode}`);
      lastSuccess = false;
    }
    res.resume();
  }).on('error', (err) => {
    console.log(`隧道保活请求错误: ${err.message}`);
    lastSuccess = false;
  });
}

// 创建HTTP服务器（处理/health路径）
const httpServer = http.createServer((req, res) => {
  // 只处理/health路径，其他路径返回404
  if (req.url === '/health') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.end('OK');
  } else {
    res.statusCode = 404;
    res.end();
  }
});

// 启动服务
async function startServices() {
  return new Promise((resolve, reject) => {
    console.log(`启动sing-box服务（端口: ${ARGO_PORT + 1}）...`);
    // 启动sing-box
    const singBoxProcess = exec('./1 run -c config.json', (error, stdout, stderr) => {
      if (error) {
        console.error(`sing-box启动失败: ${error.message}`);
        if (stderr) console.error(`sing-box错误详情: ${stderr}`);
        reject(error);
      }
    });
    
    // 检查sing-box是否启动成功
    setTimeout(() => {
      try {
        execSync('pgrep -f "./1 run"');
        console.log('sing-box启动成功');
        
        // 创建TCP服务器实现端口复用
        const tcpServer = net.createServer((socket) => {
          let protocolBuffer = Buffer.alloc(0);
          let protocolDetermined = false;
          
          socket.on('data', (chunk) => {
            protocolBuffer = Buffer.concat([protocolBuffer, chunk]);
            
            if (!protocolDetermined) {
              const isHttp = protocolBuffer.toString('utf8').includes('HTTP/1.1') || 
                            protocolBuffer.toString('utf8').includes('GET ') || 
                            protocolBuffer.toString('utf8').includes('POST ');
              
              protocolDetermined = true;
              
              if (isHttp) {
                console.log('接收到HTTP请求，转发到HTTP服务器');
                httpServer.emit('connection', socket);
                socket.unshift(protocolBuffer);
              } else {
                console.log('接收到非HTTP请求，转发到sing-box');
                const singBoxSocket = net.connect(ARGO_PORT + 1, '127.0.0.1', () => {
                  singBoxSocket.write(protocolBuffer);
                  socket.pipe(singBoxSocket);
                  singBoxSocket.pipe(socket);
                });
                
                singBoxSocket.on('error', (err) => {
                  console.error(`连接sing-box失败: ${err.message}`);
                  socket.destroy();
                });
              }
            }
          });
        });
        
        // 监听ARGO_PORT
        tcpServer.listen(ARGO_PORT, () => {
          console.log(`TCP复用服务器已启动，监听端口: ${ARGO_PORT}`);
          console.log(`HTTP请求(/health)将在此端口处理，其他流量将转发到sing-box (${ARGO_PORT + 1})`);
        });
        
        tcpServer.on('error', (err) => {
          console.error(`TCP服务器启动失败: ${err.message}`);
          reject(err);
        });
        
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
        
        console.log('启动cloudflared服务...');
        const cloudflaredProcess = exec(cloudflaredCommand, (error, stdout, stderr) => {
          if (error) {
            console.error(`cloudflared启动失败: ${error.message}`);
            if (stderr) console.error(`cloudflared错误详情: ${stderr}`);
            if (fs.existsSync('boot.log')) {
              console.log('cloudflared日志内容:');
              console.log(fs.readFileSync('boot.log', 'utf8'));
            }
            reject(error);
          }
        });
        
        // 检查cloudflared是否启动成功
        setTimeout(() => {
          try {
            execSync('pgrep -f "./2 tunnel"');
            console.log('cloudflared启动成功');
            resolve();
          } catch (e) {
            console.error('cloudflared启动失败');
            if (fs.existsSync('boot.log')) {
              console.log('cloudflared日志内容:');
              console.log(fs.readFileSync('boot.log', 'utf8'));
            }
            reject(new Error('cloudflared启动失败'));
          }
        }, 2000);
        
      } catch (e) {
        console.error('sing-box启动失败');
        reject(new Error('sing-box启动失败'));
      }
    }, 2000);
    
    // 捕获退出信号，清理进程
    process.on('SIGINT', () => {
      console.log('\n接收到退出信号，正在停止服务...');
      try {
        execSync('pkill -f "./1 run"');
        execSync('pkill -f "./2 tunnel"');
        console.log('服务已成功停止');
      } catch (e) {
        console.error('停止服务时出错:', e.message);
      }
      process.exit(0);
    });
  });
}

// 获取Argo域名
function getArgoDomain() {
  if (ARGO_DOMAIN) {
    console.log(`使用预设域名: ${ARGO_DOMAIN}`);
    SELF_URL = `https://${ARGO_DOMAIN}`;
    return Promise.resolve(ARGO_DOMAIN);
  } else {
    console.log('等待Cloudflare分配临时域名...');
    let retry = 0;
    const maxRetries = 10;
    
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        retry++;
        if (retry > maxRetries) {
          clearInterval(interval);
          console.error('获取临时域名超时');
          resolve('unknown.trycloudflare.com');
          return;
        }
        
        if (fs.existsSync('boot.log')) {
          const logContent = fs.readFileSync('boot.log', 'utf8');
          const match = logContent.match(/https:\/\/([^/]*trycloudflare\.com)/);
          if (match) {
            clearInterval(interval);
            const domain = match[1];
            SELF_URL = `https://${domain}`;
            console.log(`获取到临时域名: ${domain}，保活链接: ${SELF_URL}/health`);
            
            // 启动保活定时器
            setInterval(keepTunnelAlive, 30000);
            console.log('隧道保活机制已启动');
            
            resolve(domain);
          }
        }
      }, 2000);
    });
  }
}

// 主函数
async function main() {
  try {
    console.log('开始部署服务...');
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
    console.log(`VMess链接已生成: vmess://${vmessBase64}`);
    
    await new Promise(() => {});
  } catch (error) {
    console.error('部署过程中出现错误:', error.message);
    process.exit(1);
  }
}

main();
