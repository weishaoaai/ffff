const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

// 环境变量设置，关键修改：将默认端口改为 8080（非特权端口）
const UUID = process.env.UUID || '96ce5271-7a3b-455b-adb3-69772d34d34e';
const ARGO_AUTH = process.env.ARGO_AUTH || '';
const CFIP = process.env.CFIP || 'www.visa.com.tw';
const NAME = process.env.NAME || 'app.koyeb.com';
// 关键修改：默认端口改为 8080（1024 以上，无需特权）
const ARGO_PORT = process.env.ARGO_PORT ? parseInt(process.env.ARGO_PORT, 10) : 8080;
const CFPORT = process.env.CFPORT ? parseInt(process.env.CFPORT, 10) : 443; // CFPORT 保持 443 不影响，因为是外部访问端口
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || '';
const FILE_PATH = process.env.FILE_PATH || 'world';
const SING_BOX_URL = "https://raw.githubusercontent.com/weishaoaai/sssss/main/sing-box";
const CLOUDFLARED_URL = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64";

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
      // 处理重定向
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
  
  // 设置可执行权限
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
      "listen": "::",
      "listen_port": ARGO_PORT, // 使用非特权端口
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
      
      // 提取隧道ID
      const match = ARGO_AUTH.match(/"id":"([^"]+)"/);
      const tunnelId = match ? match[1] : 'unknown';
      
      const tunnelConfig = `tunnel: ${tunnelId}
credentials-file: tunnel.json
protocol: http2

ingress:
  - hostname: ${ARGO_DOMAIN}
    service: http://localhost:${ARGO_PORT}  # 隧道指向非特权端口
    originRequest:
      noTLSVerify: true
  - service: http_status:200`;  // 修改为 200 OK 响应
      
      fs.writeFileSync('tunnel.yml', tunnelConfig);
      console.log(`隧道配置已生成，使用域名: ${ARGO_DOMAIN}`);
    } else {
      console.log('使用令牌认证方式配置隧道');
    }
  } else {
    console.log('未提供ARGO_AUTH和ARGO_DOMAIN，使用临时域名');
  }
}

// 启动服务
async function startServices() {
  return new Promise((resolve, reject) => {
    console.log(`启动sing-box服务（端口: ${ARGO_PORT}）...`);
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
        
        // 启动cloudflared（隧道指向非特权端口）
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
            console.log(`获取到临时域名: ${domain}`);
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
      "port": CFPORT,  // 外部访问端口仍为 443（Cloudflare 会处理转发）
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
    
    
    // 保持进程运行
    await new Promise(() => {});
  } catch (error) {
    console.error('部署过程中出现错误:', error.message);
    process.exit(1);
  }
}

main(); 
