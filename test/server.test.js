const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../server');

test('desktop FlyAI runner is used for searches', async () => {
  const calls = [];
  const { server, url } = await startServer({
    host: '127.0.0.1',
    port: 0,
    flyaiRunner: async request => {
      calls.push(request);
      return { data: { itemList: [] } };
    }
  });

  try {
    const response = await fetch(`${url}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: url },
      body: JSON.stringify({
        origin: '广州',
        destination: '上海',
        trip: 'oneway',
        depDate: '2026-09-16',
        outTimeStart: '06:00',
        outTimeEnd: '23:00'
      })
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(result.results, []);
    assert.equal(calls.length, 4);
    assert.ok(calls.every(call => call.args.includes('--destination') && call.args.includes('上海')));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('nationwide exploration supplements domestic destinations and ranks them first', { timeout: 20000 }, async () => {
  const calls = [];
  const flightResult = (city, code, price) => ({
    data: {
      itemList: [{
        adultPrice: `¥${price}`,
        journeys: [{
          journeyType: '直达',
          totalDuration: '120分钟',
          segments: [{
            depCityCode: 'CAN', depCityName: '广州', depStationCode: 'CAN', depDateTime: '2026-10-08 09:00:00',
            arrCityCode: code, arrCityName: city, arrStationCode: code, arrDateTime: '2026-10-08 11:00:00',
            duration: '120分钟', marketingTransportName: '测试航司'
          }]
        }]
      }]
    }
  });
  const { server, url } = await startServer({
    host: '127.0.0.1',
    port: 0,
    flyaiRunner: async request => {
      calls.push(request);
      const destinationIndex = request.args.indexOf('--destination');
      if (destinationIndex < 0) return request.args.includes('3') ? flightResult('中国台北', 'TPE', 120) : flightResult('首尔', 'SEL', 100);
      const city = request.args[destinationIndex + 1];
      return flightResult(city, `D${String(calls.length).padStart(2, '0')}`, 500 + calls.length);
    }
  });

  try {
    const response = await fetch(`${url}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: url },
      body: JSON.stringify({ origin: '广州', destination: 'all', trip: 'oneway', depDate: '2026-10-08', outTimeStart: '06:00', outTimeEnd: '23:00' })
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(calls.filter(call => call.args.includes('--destination')).length, 9);
    assert.equal(result.results.filter(item => item.domestic).length, 10);
    assert.equal(result.results.at(-1).city, '首尔');
    assert.equal(result.results.at(-1).domestic, false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
