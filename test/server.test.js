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

test('nationwide round trips add fallback destinations when few trips match', { timeout: 20000 }, async () => {
  const calls = [];
  const codesByCity = new Map([['上海', 'SHA'], ['北京', 'BJS']]);
  let outboundDestinationCalls = 0;
  const flightItem = (fromCity, fromCode, toCity, toCode, price, date) => ({
    adultPrice: `¥${price}`,
    journeys: [{
      journeyType: '直达',
      totalDuration: '120分钟',
      segments: [{
        depCityCode: fromCode, depCityName: fromCity, depStationCode: fromCode, depDateTime: `${date} 09:00:00`,
        arrCityCode: toCode, arrCityName: toCity, arrStationCode: toCode, arrDateTime: `${date} 11:00:00`,
        duration: '120分钟', marketingTransportName: '测试航司'
      }]
    }]
  });
  const flightResponse = items => ({ data: { itemList: items } });
  const { server, url } = await startServer({
    host: '127.0.0.1',
    port: 0,
    flyaiRunner: async request => {
      calls.push(request);
      const args = request.args;
      const destinationIndex = args.indexOf('--destination');
      const origin = args[args.indexOf('--origin') + 1];
      const destination = destinationIndex >= 0 ? args[destinationIndex + 1] : '';
      const date = args[args.indexOf('--dep-date') + 1];
      if (destinationIndex < 0) {
        return flightResponse([
          flightItem('广州', 'CAN', '上海', 'SHA', 500, date),
          flightItem('广州', 'CAN', '北京', 'BJS', 550, date)
        ]);
      }
      if (origin === '广州' && destination !== '广州') {
        outboundDestinationCalls++;
        if (outboundDestinationCalls <= 8) throw new Error('暂时没有航班');
        const code = `D${String(outboundDestinationCalls).padStart(2, '0')}`;
        codesByCity.set(destination, code);
        return flightResponse([flightItem('广州', 'CAN', destination, code, 600 + outboundDestinationCalls, date)]);
      }
      const code = args[args.indexOf('--origin') + 1];
      const city = [...codesByCity.entries()].find(([, value]) => value === code)?.[0] || '测试目的地';
      return flightResponse([flightItem(city, code, '广州', 'CAN', 600, date)]);
    }
  });

  try {
    const response = await fetch(`${url}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: url },
      body: JSON.stringify({
        origin: '广州',
        destination: 'all',
        trip: 'round',
        depDate: '2026-10-08',
        backDate: '2026-10-12'
      })
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(new Set(result.results.map(item => item.code)).size, 6);
    assert.ok(result.results.every(item => item.back));
    assert.equal(outboundDestinationCalls, 12);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
