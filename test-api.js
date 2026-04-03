const axios = require('axios');
const crypto = require('crypto');

const API_URL = 'https://region3.homgarus.com';
const email = 'james+homebridgehomgar@shallcrass.co.uk';
const password = 'zapceh-bynxiw-5cUtta';
const areaCode = '44';

const passwordMd5 = crypto.createHash('md5').update(password).digest('hex');
const deviceId = crypto.createHash('md5').update(email + areaCode).digest('hex');

async function test() {
  console.log('Logging in...');
  const loginRes = await axios.post(`${API_URL}/auth/basic/app/login`, {
    areaCode,
    phoneOrEmail: email,
    password: passwordMd5,
    deviceId,
  }, {
    headers: { 'Content-Type': 'application/json', lang: 'en', appCode: '1' },
  });

  if (loginRes.data.code !== 0) {
    // Try appCode 2 (RainPoint) or 3 (Diivoo)
    console.log('appCode 1 failed:', loginRes.data.msg, '- trying appCode 2...');
    const loginRes2 = await axios.post(`${API_URL}/auth/basic/app/login`, {
      areaCode,
      phoneOrEmail: email,
      password: passwordMd5,
      deviceId,
    }, {
      headers: { 'Content-Type': 'application/json', lang: 'en', appCode: '2' },
    });
    console.log('appCode 2 result:', JSON.stringify(loginRes2.data, null, 2));
    return;
  }

  const token = loginRes.data.data.token;
  console.log('Login success! Token expires in', loginRes.data.data.tokenExpired, 'seconds');

  const headers = { auth: token, lang: 'en', appCode: '1' };

  console.log('\nFetching homes...');
  const homesRes = await axios.get(`${API_URL}/app/member/appHome/list`, { headers });
  console.log('Homes:', JSON.stringify(homesRes.data.data, null, 2));

  if (homesRes.data.data && homesRes.data.data.length > 0) {
    const hid = homesRes.data.data[0].hid;
    console.log(`\nFetching devices for home ${hid}...`);
    const devicesRes = await axios.get(`${API_URL}/app/device/getDeviceByHid`, {
      params: { hid: String(hid) },
      headers,
    });
    console.log('Devices:', JSON.stringify(devicesRes.data.data, null, 2).substring(0, 3000));

    // Get status for first hub
    if (devicesRes.data.data && devicesRes.data.data.length > 0) {
      const mid = devicesRes.data.data[0].mid;
      console.log(`\nFetching status for mid=${mid}...`);
      const statusRes = await axios.get(`${API_URL}/app/device/getDeviceStatus`, {
        params: { mid },
        headers,
      });
      console.log('Status:', JSON.stringify(statusRes.data.data, null, 2));
    }
  }
}

test().catch(e => console.error('Error:', e.response?.data || e.message));
