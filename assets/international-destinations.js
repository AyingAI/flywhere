const internationalDestinations = [
  { code: 'TYO', name: '东京', country: '日本', region: '东亚', coordinate: [139.69, 35.68], airports: ['HND', 'NRT'] },
  { code: 'OSA', name: '大阪', country: '日本', region: '东亚', coordinate: [135.50, 34.69], airports: ['KIX', 'ITM', 'UKB'] },
  { code: 'SEL', name: '首尔', country: '韩国', region: '东亚', coordinate: [126.98, 37.57], airports: ['ICN', 'GMP'] },
  { code: 'SIN', name: '新加坡', region: '东南亚', coordinate: [103.82, 1.35] },
  { code: 'BKK', name: '曼谷', country: '泰国', region: '东南亚', coordinate: [100.50, 13.76], airports: ['DMK'] },
  { code: 'KUL', name: '吉隆坡', country: '马来西亚', region: '东南亚', coordinate: [101.69, 3.14], airports: ['SZB'] },
  { code: 'HKG', name: '香港', region: '港澳台', coordinate: [114.17, 22.32] },
  { code: 'MFM', name: '澳门', region: '港澳台', coordinate: [113.55, 22.20], directedOnly: true },
  { code: 'TPE', name: '台北', region: '港澳台', coordinate: [121.56, 25.04], airports: ['TSA'] },
  { code: 'DXB', name: '迪拜', country: '阿联酋', region: '中东', coordinate: [55.27, 25.20], airports: ['DWC'] },
  { code: 'LHR', cityCode: 'LON', name: '伦敦', airportLabel: '伦敦希思罗', country: '英国', region: '欧洲', coordinate: [-0.13, 51.51], airports: ['LGW', 'STN', 'LTN', 'LCY'] },
  { code: 'CDG', cityCode: 'PAR', name: '巴黎', airportLabel: '巴黎戴高乐', country: '法国', region: '欧洲', coordinate: [2.35, 48.86], airports: ['ORY'] },
  { code: 'LAX', name: '洛杉矶', country: '美国', region: '北美', coordinate: [-118.24, 34.05] },
  { code: 'SYD', name: '悉尼', country: '澳大利亚', region: '大洋洲', coordinate: [151.21, -33.87] }
];

if (typeof module !== 'undefined') module.exports = internationalDestinations;
