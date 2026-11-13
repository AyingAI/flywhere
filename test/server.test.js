const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startServer } = require('../server');

test('saved credentials are restricted to the configured AI endpoint', async () => {
  const { mkdtemp, rm } = require('node:fs/promises');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const directory = await mkdtemp(join(tmpdir(), 'flywhere-security-'));
  const key = 'local-test-placeholder';
  const requests = [];
  const provider = http.createServer((request, response) => {
    requests.push({ url: request.url, authorized: request.headers.authorization === `Bearer ${key}` });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'example-model' }] }));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const providerUrl = `http://127.0.0.1:${provider.address().port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: join(__dirname, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', FLYWHERE_CONFIG_PATH: join(directory, 'settings.json'), AI_BASE_URL: providerUrl, AI_API_KEY: key }
  });
  try {
    const [stdout] = await once(child.stdout, 'data');
    const url = stdout.toString().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    assert.ok(url);
    const post = (path, body) => fetch(url + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify(body)
    });
    assert.equal((await post('/api/models', { baseUrl: providerUrl + '/v1/', useSavedKey: true })).status, 200);
    assert.equal((await post('/api/models', { baseUrl: providerUrl + '/other', useSavedKey: true })).status, 400);
    assert.deepEqual(requests, [{ url: '/v1/models', authorized: true }]);
    const settings = await post('/api/settings', { aiBaseUrl: providerUrl + '/other' });
    const body = await settings.text();
    assert.equal(settings.status, 200);
    assert.equal(JSON.parse(body).hasAiApiKey, false);
    assert.equal(body.includes(key), false);
    const crossSite = await fetch(url + '/api/settings', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(crossSite.status, 403);
  } finally {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
    await new Promise(resolve => provider.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

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

test('all airports can mix round-trip airports and a specified airport filters both legs', { timeout: 10000 }, async () => {
  const calls = [];
  const flight = (from, to, date) => ({
    ticketPrice: '400',
    journeys: [{
      journeyType: '直达',
      totalDuration: '110',
      segments: [{
        depStationCode: from, depStationShortName: from === 'SHA' ? '虹桥' : from === 'PVG' ? '浦东' : '高崎',
        arrStationCode: to, arrStationShortName: to === 'SHA' ? '虹桥' : to === 'PVG' ? '浦东' : '高崎',
        arrCityCode: to === 'XMN' ? 'XMN' : 'SHA', arrCityName: to === 'XMN' ? '厦门' : '上海',
        depDateTime: `${date} 09:00:00`, arrDateTime: `${date} 10:50:00`,
        duration: '110', marketingTransportName: '测试航司'
      }]
    }]
  });
  const { server, url } = await startServer({
    port: 0,
    flyaiRunner: async ({ args }) => {
      const origin = args[args.indexOf('--origin') + 1];
      const destination = args[args.indexOf('--destination') + 1];
      const date = args[args.indexOf('--dep-date') + 1];
      calls.push({ origin, destination });
      // Simulate an upstream response that includes both airports even for an airport query.
      const itemList = ['SHA', 'PVG'].map(airport =>
        origin === 'XMN' ? flight('XMN', airport, date) : flight(airport, 'XMN', date)
      );
      return { data: { itemList } };
    }
  });
  async function search(originAirport) {
    const response = await fetch(`${url}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: url },
      body: JSON.stringify({ origin: '上海', originAirport, destination: '厦门', trip: 'round', depDate: '2026-12-12', backDate: '2026-12-16' })
    });
    assert.equal(response.status, 200);
    return (await response.json()).results;
  }
  try {
    const all = await search('');
    assert.equal(all.length, 4);
    assert.equal(new Set(all.map(item => item.id)).size, 4);
    assert.ok(all.some(item => item.outDepartureAirport.code === 'SHA' && item.backArrivalAirport.code === 'PVG'));

    for (const [airport, airportQuery] of [['SHA', '上海虹桥'], ['PVG', 'PVG']]) {
      const exact = await search(airport);
      assert.equal(exact.length, 1);
      assert.equal(exact[0].outDepartureAirport.code, airport);
      assert.equal(exact[0].backArrivalAirport.code, airport);
      assert.ok(calls.some(call => call.origin === airportQuery && call.destination === '厦门'));
      assert.ok(calls.some(call => call.origin === 'XMN' && call.destination === airportQuery));
    }
    assert.deepEqual(await search(''), all);
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

function internationalLeg(from, to, departure, arrival) {
  return {
    journeyType: '直达',
    totalDuration: '180',
    segments: [{
      depCityCode: from[0], depCityName: from[1], depStationCode: from[2], depStationShortName: from[3],
      arrCityCode: to[0], arrCityName: to[1], arrStationCode: to[2], arrStationShortName: to[3],
      depDateTime: departure, arrDateTime: arrival, duration: '180', marketingTransportNo: 'TEST123'
    }]
  };
}

test('domestic preferences filter both legs and keep searches with different preferences separate', { timeout: 8000 }, async () => {
  const guangzhou = ['CAN', '广州', 'CAN', '白云'];
  const hangzhou = ['HGH', '杭州', 'HGH', '萧山'];
  const makeQuote = (from, to, departure, arrival, minutes) => {
    const journey = internationalLeg(from, to, departure, arrival);
    journey.totalDuration = journey.segments[0].duration = String(minutes);
    return { ticketPrice: '450', journeys: [journey] };
  };
  const outbound = [
    makeQuote(guangzhou, hangzhou, '2026-12-20 09:00:00', '2026-12-20 10:50:00', 110),
    makeQuote(guangzhou, hangzhou, '2026-12-20 09:30:00', '2026-12-20 12:00:00', 150),
    makeQuote(guangzhou, hangzhou, '2026-12-20 04:00:00', '2026-12-20 05:55:00', 115)
  ];
  const inbound = [
    makeQuote(hangzhou, guangzhou, '2026-12-23 15:00:00', '2026-12-23 17:00:00', 120),
    makeQuote(hangzhou, guangzhou, '2026-12-23 16:00:00', '2026-12-23 18:10:00', 130),
    makeQuote(hangzhou, guangzhou, '2026-12-23 23:00:00', '2026-12-24 00:50:00', 110)
  ];
  const { server, url } = await startServer({
    port: 0,
    flyaiRunner: async ({ args }) => ({
      data: { itemList: args[args.indexOf('--origin') + 1] === 'HGH' ? inbound : outbound }
    })
  });
  async function search(preferences) {
    const response = await fetch(`${url}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: url },
      body: JSON.stringify({
        scope: 'domestic', origin: '广州', originAirport: 'CAN', destination: '杭州',
        trip: 'round', depDate: '2026-12-20', backDate: '2026-12-23', ...preferences
      })
    });
    assert.equal(response.status, 200);
    return (await response.json()).results;
  }
  try {
    assert.equal((await search({})).length, 9);
    assert.equal((await search({ maxFlightHours: 2 })).length, 4);
    assert.equal((await search({ avoidRedeye: true })).length, 4);
    const results = await search({ maxFlightHours: 2, avoidRedeye: true });
    assert.deepEqual(results.map(({ out, back }) => [out, back]), [['09:00', '15:00']]);
    assert.equal((await search({})).length, 9);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('international round-trip quotes keep both legs, the quote and the original taxes', { timeout: 6000 }, async () => {
  const pvg = ['SHA', '上海', 'PVG', '浦东'];
  const sha = ['SHA', '上海', 'SHA', '虹桥'];
  const nrt = ['TYO', '东京', 'NRT', '成田'];
  const hnd = ['TYO', '东京', 'HND', '羽田'];
  const out = internationalLeg(pvg, nrt, '2026-12-12 22:30:00', '2026-12-13 02:30:00');
  const back = internationalLeg(hnd, pvg, '2026-12-16 11:00:00', '2026-12-16 13:00:00');
  const alternative = internationalLeg(nrt, pvg, '2026-12-16 15:00:00', '2026-12-16 17:00:00');
  const wrongAirport = internationalLeg(nrt, sha, '2026-12-16 15:00:00', '2026-12-16 17:00:00');
  const calls = [];
  const { server, url } = await startServer({
    port: 0,
    flyaiRunner: async ({ args }) => {
      calls.push(args);
      return { status: 0, data: { itemList: [
        { ticketPrice: '2402.35', journeys: [out, back], jumpUrl: 'https://router.feizhu.com/test' },
        { ticketPrice: '2800', taxFee: '0', journeys: [out, alternative] },
        { ticketPrice: '200', journeys: [out, wrongAirport] },
        { ticketPrice: '300', currency: 'USD', journeys: [out, back] },
        { ticketPrice: '400', journeys: [out] }
      ] } };
    }
  });

  try {
    const response = await fetch(`${url}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: url },
      body: JSON.stringify({ scope: 'international', origin: '上海', originAirport: 'PVG', destination: 'TYO', trip: 'round', depDate: '2026-12-12', backDate: '2026-12-16', passengers: 2 })
    });
    assert.equal(response.status, 200);
    const { results, coverage } = await response.json();
    assert.equal(results.length, 2);
    assert.equal(coverage.completed, 1);
    assert.ok(calls.every(args => args.includes('--back-date') && args.includes('PVG')));
    const [complete, pending] = results;
    assert.equal(complete.feesPending, false);
    assert.equal(complete.feeSource, '接口');
    assert.equal(pending.feesPending, true);
    assert.equal(pending.totalPrice, 4804.7);
    assert.equal(pending.fees, 0);
    assert.equal(pending.outArrivalDate, '2026-12-13');
    assert.equal(pending.outArrivalAirport.code, 'NRT');
    assert.equal(pending.backDepartureAirport.code, 'HND');
    assert.equal(pending.backArrivalAirport.code, 'PVG');
    assert.equal(pending.outSegments[0].arrival, '2026-12-13 02:30:00');
    assert.equal(pending.jumpUrl, 'https://router.feizhu.com/test');

    const exactAirportResponse = await fetch(`${url}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: url },
      body: JSON.stringify({ scope: 'international', origin: '上海', originAirport: 'PVG', destination: 'NRT', trip: 'round', depDate: '2026-12-12', backDate: '2026-12-16' })
    });
    const exactAirport = (await exactAirportResponse.json()).results;
    assert.equal(exactAirport.length, 1);
    assert.equal(exactAirport[0].backDepartureAirport.code, 'NRT');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('international exploration streams progress and recovers fares alongside failed destinations', { timeout: 12000 }, async () => {
  const origin = ['SIN', '新加坡', 'SIN', '樟宜'];
  const tokyo = internationalLeg(origin, ['TYO', '东京', 'NRT', '成田'], '2026-12-15 09:00:00', '2026-12-15 16:00:00');
  const bangkok = internationalLeg(origin, ['BKK', '曼谷', 'BKK', '素万那普'], '2026-12-15 10:00:00', '2026-12-15 12:30:00');
  const calls = [];
  const { server, url } = await startServer({
    port: 0,
    flyaiRunner: async ({ args }) => {
      const destination = args[args.indexOf('--destination') + 1];
      const sort = args[args.indexOf('--sort-type') + 1];
      calls.push(args);
      if (destination === 'LHR' || (destination === 'BKK' && sort === '3')) return { status: 1, message: '查询失败' };
      const itemList = [];
      if (destination === 'TYO') itemList.push({ ticketPrice: '850', journeys: [tokyo] });
      if (destination === 'BKK') itemList.push({ ticketPrice: '630', journeys: [bangkok] });
      return { status: 0, data: { itemList } };
    }
  });

  try {
    const request = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: url },
      body: JSON.stringify({ scope: 'international', origin: 'SIN', destination: 'all', trip: 'oneway', depDate: '2026-12-15' })
    };
    const response = await fetch(`${url}/api/search`, {
      ...request, headers: { ...request.headers, Accept: 'application/x-ndjson' }
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^application\/x-ndjson\b/);
    const [stream, json] = await Promise.all([response.text(), fetch(`${url}/api/search`, request).then(result => result.json())]);
    const events = stream.trim().split('\n').map(line => JSON.parse(line));
    const { type, results, coverage } = events.at(-1);
    assert.equal(events[0].type, 'progress');
    assert.equal(events[0].coverage.matched, 0);
    assert.ok(events.some(event => event.coverage?.phase === 'search' && event.coverage.matched === 1));
    assert.ok(events.some(event => event.coverage?.phase === 'recovery' && event.coverage.matched === 2));
    assert.equal(type, 'result');
    assert.deepEqual(results.map(({ code, totalPrice }) => [code, totalPrice]), [['BKK', 630], ['TYO', 850]]);
    assert.deepEqual(json, { results, coverage });
    assert.equal(coverage.failed, 1);
    assert.equal(coverage.attempted, coverage.planned);
    assert.equal(coverage.completed, coverage.planned - 1);
    const destinations = Object.fromEntries(coverage.destinations.map(({ code, status }) => [code, status]));
    assert.equal(destinations.TYO, 'quoted');
    assert.equal(destinations.BKK, 'quoted');
    assert.equal(destinations.LHR, 'failed');
    assert.equal(destinations.OSA, 'empty');
    assert.equal(destinations.SIN, undefined);
    assert.equal(calls.filter(args => args[args.indexOf('--sort-type') + 1] === '3').length, coverage.planned);
    assert.ok(calls.every(args => args.includes('--destination') && !args.includes('--back-date')));
    assert.ok(calls.every(args => args[args.indexOf('--destination') + 1] !== 'SIN'));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('international route falls back to separately booked tickets when a through quote fails', { timeout: 8000 }, async () => {
  const pvg = ['SHA', '上海', 'PVG', '浦东'];
  const bkk = ['BKK', '曼谷', 'BKK', '素万那普'];
  const out = internationalLeg(pvg, bkk, '2026-12-12 22:30:00', '2026-12-13 02:30:00');
  const back = internationalLeg(bkk, pvg, '2026-12-16 11:00:00', '2026-12-16 16:00:00');
  const { server, url } = await startServer({
    port: 0,
    flyaiRunner: async ({ args }) => {
      if (args.includes('--back-date')) return { status: 1, message: '整组往返未返回' };
      const inbound = args[args.indexOf('--origin') + 1] === 'BKK';
      return { status: 0, data: { itemList: [inbound
        ? { ticketPrice: '550', journeys: [back], jumpUrl: 'https://router.feizhu.com/back' }
        : { ticketPrice: '450', taxFee: '75', journeys: [out], jumpUrl: 'https://router.feizhu.com/out' }] } };
    }
  });
  try {
    const response = await fetch(`${url}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: url },
      body: JSON.stringify({ scope: 'international', origin: '上海', destination: 'BKK', trip: 'round', depDate: '2026-12-12', backDate: '2026-12-16' })
    });
    assert.equal(response.status, 200);
    const { results, coverage } = await response.json();
    assert.equal(results.length, 1);
    const result = results[0];
    assert.equal(result.separateTickets, true);
    assert.equal(result.feesPending, true);
    assert.equal(result.fees, 75);
    assert.equal(result.totalPrice, 1075);
    assert.equal(result.jumpUrl, 'https://router.feizhu.com/out');
    assert.equal(result.backJumpUrl, 'https://router.feizhu.com/back');
    assert.equal(coverage.completed, 1);
    assert.equal(coverage.failed, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('international exploration reports unqueried destinations when the provider restricts access', async () => {
  let calls = 0;
  const { server, url } = await startServer({
    port: 0,
    flyaiRunner: async () => {
      calls++;
      throw new Error('MCP HTTP 403: Abnormal access behavior detected by risk control');
    }
  });
  try {
    const response = await fetch(`${url}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: url, Accept: 'application/x-ndjson' },
      body: JSON.stringify({ scope: 'international', origin: 'CAN', destination: 'all', trip: 'oneway', depDate: '2026-12-12' })
    });
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    const final = events.at(-1);
    assert.equal(final.type, 'error');
    assert.equal(calls, 1);
    assert.equal(final.coverage.failed, 1);
    assert.equal(final.coverage.destinations.filter(city => city.status === 'unqueried').length, final.coverage.planned - 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('round-trip exploration checks separate tickets beyond the first four destinations', { timeout: 18000 }, async () => {
  const origin = ['CAN', '广州', 'CAN', '白云'];
  const sydney = ['SYD', '悉尼', 'SYD', '悉尼机场'];
  const out = internationalLeg(origin, sydney, '2026-12-12 08:00:00', '2026-12-12 20:00:00');
  const back = internationalLeg(sydney, origin, '2026-12-16 10:00:00', '2026-12-16 19:00:00');
  const { server, url } = await startServer({
    port: 0,
    flyaiRunner: async ({ args }) => {
      if (args.includes('--back-date')) return { status: 1, message: '整组往返未返回' };
      const from = args[args.indexOf('--origin') + 1];
      const to = args[args.indexOf('--destination') + 1];
      const journey = to === 'SYD' ? out : from === 'SYD' ? back : null;
      return { status: 0, data: { itemList: journey ? [{ ticketPrice: '950', taxFee: '75', journeys: [journey] }] : [] } };
    }
  });
  try {
    const response = await fetch(`${url}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: url },
      body: JSON.stringify({ scope: 'international', origin: '广州', originAirport: 'CAN', destination: 'all', trip: 'round', depDate: '2026-12-12', backDate: '2026-12-16' })
    });
    assert.equal(response.status, 200);
    const { results, coverage } = await response.json();
    assert.equal(results.length, 1);
    assert.equal(results[0].code, 'SYD');
    assert.equal(results[0].separateTickets, true);
    assert.equal(results[0].totalPrice, 2050);
    assert.equal(coverage.completed, coverage.planned);
    assert.equal(coverage.failed, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
