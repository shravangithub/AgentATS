/* AgentATS live demo — mock google.script.run backend.
   Everything here is FICTIONAL sample data. Nothing is sent anywhere and nothing is saved:
   write actions either return a friendly "disabled in the demo" message or change an
   in-memory copy that disappears when the tab is closed. */
(function () {
  'use strict';
  var DEMO_MSG = 'This action is disabled in the live demo — install AgentATS to use it.';
  var GITHUB = 'https://github.com/shravangithub/AgentATS';

  /* ------------------------------------------------------------------ helpers */
  var NOW = new Date();
  function daysAgo(n, h, m) { var d = new Date(NOW.getTime() - n * 86400000); d.setHours(h == null ? 10 : h, m == null ? 0 : m, 0, 0); return d; }
  function daysAhead(n, h, m) { return daysAgo(-n, h, m); }
  function z(n) { return (n < 10 ? '0' : '') + n; }
  function fmt(d) { return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + ' ' + z(d.getHours()) + ':' + z(d.getMinutes()); }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function fmtLong(d) { return z(d.getDate()) + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear() + ', ' + z(d.getHours()) + ':' + z(d.getMinutes()); }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function hash(s) { var h = 2166136261; s = String(s); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0); }
  function jit(key, span) { return ((hash(key) % 1000) / 1000 - 0.5) * span; } // deterministic in [-span/2, span/2]
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function low(s) { return (s || '').toString().toLowerCase(); }
  function first(n) { return (n || '').split(' ')[0]; }

  /* ------------------------------------------------------------------ rubric engine (extracted from TalentRubric.gs) */
  var ENGINE = {"categories":["Experience – Quantity & Duration","Experience – Relevance & Quality","Career Trajectory & Progression","Tenure & Stability","Employer Pedigree & Company Signals","Job Title & Role Signals","Education – Institution","Education – Degree & Performance","Certifications & Licenses","Technical Skills – Breadth & Depth","Tools, Platforms & Stack Specificity","Domain & Industry Expertise","Functional Competencies","Soft Skills & Behavioral Signals","Leadership & People Management","Achievement & Impact Quantification","Projects & Portfolio","Publications, Patents & Research","Awards & Recognition","Professional Community & Influence","JD / Role-Fit Alignment","Seniority & Scope Indicators","Compensation & Level Signals","Location & Logistics","Work Authorization & Mobility","Language & Communication","Resume Quality & Formatting","Risk / Red Flags","Differentiators / Green Flags","Culture & Values Signals","Fairness & Bias Controls","Digital Footprint & External Validation","Adaptability & Learning Agility","Skill Recency & Currency","Entrepreneurial & Innovation Signals","Sales & Commercial Performance","Non-Tech Functional Depth"],"archetypes":["Junior Technical IC","Mid Technical IC","Senior Technical IC","Engineering Leadership","Junior Product/Design","Senior Product/Design","Junior GTM/Commercial","Senior GTM/Commercial","Finance/Quant/Analytics","Research/Scientific","Legal/Compliance","Operations/PMO/People","Executive Leadership","General","Marketing & Content","Customer Success & Support","Data/ML Engineering","HR/Talent/Recruiting","Chief of Staff / BizOps","DevOps / SRE / Platform","Security Engineering / InfoSec","Data Science & Analytics","Solutions / Sales Engineering","UX / Product Design","Supply Chain / Logistics / Category","QA / Test Engineering","Hardware / Embedded Engineering","Technical Program Management","Clinical / Regulatory Affairs","Strategy / Management Consultant","Sustainability / ESG Specialist","Public Policy / Government Affairs","Risk / Actuarial / Compliance","Investment / Portfolio (PE/VC/Markets)"],"companies":["Services — IT Scale","Services — High-End Eng","Product — Consumer/App","Product — Dev/API Tools","Product — Enterprise Platform","Product — Infra/Cloud/Data","E-commerce/Marketplace","Mid-cap SaaS","Frontier AI","Industrial/Embedded AI","Fintech Infra/Payments","CRM/GTM-tech","BFSI/Banks","GCC — Global Capability Center","E-commerce — Quick Commerce","E-commerce — Fashion/Lifestyle","Cybersecurity","Datacenter/Cloud Infrastructure","Manufacturing/Industrial","Healthcare/Pharma/Biotech","EdTech","Gaming/Media/Entertainment","Telecom/Networking","Climate / CleanTech / Renewables","ESG / Sustainability","NGO / Non-profit / Social Impact","Management Consulting (MBB / Big 4)","Government / Public Sector / PSU","Logistics / Supply Chain / Mobility","PropTech / Real Estate / Construction","Travel / Hospitality / Aviation","Agritech / FoodTech","LegalTech / RegTech","HRTech / Staffing","InsurTech / Insurance","Crypto / Web3 / Blockchain","Robotics / Autonomous Systems","Aerospace / Space / Defense","Automotive / EV / Mobility","Retail / Omnichannel","FMCG / CPG","Medical Devices","Semiconductor / Chip Design","Energy / Oil & Gas / Utilities","NBFC / Lending / Fintech-Lending","Capital Markets / PE / VC / Hedge Fund","Advertising / Creative Agency","DeepTech / Hard-science Startup","Research / Academia / Think Tank","AI — Fintech / Risk","AI — Healthcare / Bio","AI — Real Estate / PropTech","AI — Retail / Commerce","AI — Legal / RegTech","AI — Public Sector / GovTech","AI — Cybersecurity"],"thresholds":{"Aggressive":80,"Balanced":65,"Lenient":50,"Volume":40},"roleWeights":{"Junior Technical IC":[1.35,1.35,1.35,1.35,1.35,1.35,1.35,9.46,1.35,13.51,10.81,1.35,1.35,1.35,1.35,1.35,8.11,1.35,1.35,1.35,5.41,1.35,1.35,1.35,1.35,1.35,1.35,4.05,1.35,1.35,2.7,1.35,6.76,1.35,1.35,1.35,1.35],"Mid Technical IC":[1.35,9.46,1.35,1.35,1.35,1.35,1.35,1.35,1.35,13.51,10.81,1.35,1.35,1.35,1.35,8.11,1.35,1.35,1.35,1.35,6.76,1.35,1.35,1.35,1.35,1.35,1.35,4.05,1.35,1.35,2.7,1.35,1.35,5.41,1.35,1.35,1.35],"Senior Technical IC":[1.35,9.46,6.76,1.35,1.35,1.35,1.35,1.35,1.35,13.51,1.35,1.35,1.35,1.35,1.35,10.81,1.35,1.35,1.35,1.35,5.41,8.11,1.35,1.35,1.35,1.35,1.35,4.05,1.35,1.35,2.7,1.35,1.35,1.35,1.35,1.35,1.35],"Engineering Leadership":[1.35,1.35,8.11,1.35,1.35,1.35,1.35,1.35,1.35,6.76,1.35,1.35,1.35,1.35,13.51,10.81,1.35,1.35,1.35,1.35,5.41,9.46,1.35,1.35,1.35,1.35,1.35,4.05,1.35,1.35,2.7,1.35,1.35,1.35,1.35,1.35,1.35],"Junior Product/Design":[1.35,1.35,1.35,1.35,1.35,1.35,1.35,8.11,1.35,1.35,1.35,1.35,13.51,9.46,1.35,1.35,10.81,1.35,1.35,1.35,6.76,1.35,1.35,1.35,1.35,1.35,1.35,4.05,1.35,1.35,2.7,1.35,5.41,1.35,1.35,1.35,1.35],"Senior Product/Design":[1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,9.46,13.51,1.35,6.76,10.81,1.35,1.35,1.35,1.35,5.41,8.11,1.35,1.35,1.35,1.35,1.35,4.05,1.35,1.35,2.7,1.35,1.35,1.35,1.35,1.35,1.35],"Junior GTM/Commercial":[1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,10.81,1.35,9.46,1.35,1.35,1.35,1.35,6.76,1.35,1.35,1.35,1.35,8.11,1.35,4.05,1.35,5.41,2.7,1.35,1.35,1.35,1.35,13.51,1.35],"Senior GTM/Commercial":[1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,9.46,1.35,1.35,8.11,10.81,1.35,1.35,1.35,1.35,5.41,6.76,1.35,1.35,1.35,1.35,1.35,4.05,1.35,1.35,2.7,1.35,1.35,1.35,1.35,13.51,1.35],"Finance/Quant/Analytics":[1.35,1.35,1.35,1.35,1.35,1.35,1.35,10.81,9.46,1.35,1.35,6.76,8.11,1.35,1.35,5.41,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,4.05,1.35,1.35,2.7,1.35,1.35,1.35,1.35,1.35,13.51],"Research/Scientific":[1.35,1.35,1.35,1.35,1.35,1.35,1.35,10.81,1.35,9.46,1.35,6.76,1.35,1.35,1.35,5.41,8.11,13.51,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,4.05,1.35,1.35,2.7,1.35,1.35,1.35,1.35,1.35,1.35],"Legal/Compliance":[1.35,1.35,1.35,1.35,1.35,1.35,1.35,9.46,10.81,1.35,1.35,8.11,6.76,1.35,1.35,1.35,1.35,1.35,1.35,1.35,5.41,1.35,1.35,1.35,1.35,1.35,1.35,4.05,1.35,1.35,2.7,1.35,1.35,1.35,1.35,1.35,13.51],"Operations/PMO/People":[1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,10.81,6.76,8.11,9.46,1.35,1.35,1.35,1.35,5.41,1.35,1.35,1.35,1.35,1.35,1.35,4.05,1.35,1.35,2.7,1.35,1.35,1.35,1.35,1.35,13.51],"Executive Leadership":[1.35,1.35,9.46,1.35,6.76,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,13.51,8.11,1.35,1.35,1.35,1.35,1.35,10.81,1.35,1.35,1.35,1.35,1.35,4.05,1.35,5.41,2.7,1.35,1.35,1.35,1.35,1.35,1.35],"General":[1.35,10.81,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,8.11,5.41,1.35,9.46,1.35,1.35,1.35,1.35,13.51,1.35,1.35,1.35,1.35,1.35,1.35,4.05,1.35,1.35,2.7,1.35,1.35,6.76,1.35,1.35,1.35],"Marketing & Content":[1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,6.76,13.51,9.46,1.35,10.81,5.41,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,4.05,8.11,1.35,2.7,1.35,1.35,1.35,1.35,1.35,1.35],"Customer Success & Support":[1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,9.46,10.81,13.51,1.35,8.11,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,4.05,1.35,5.41,2.7,1.35,1.35,1.35,1.35,6.76,1.35],"Data/ML Engineering":[1.35,5.41,1.35,1.35,1.35,1.35,1.35,1.35,1.35,13.51,10.81,6.76,1.35,1.35,1.35,9.46,8.11,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,4.05,1.35,1.35,2.7,1.35,1.35,1.35,1.35,1.35,1.35],"HR/Talent/Recruiting":[1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,8.11,13.51,10.81,6.76,9.46,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,4.05,1.35,5.41,2.7,1.35,1.35,1.35,1.35,1.35,1.35],"Chief of Staff / BizOps":[1.35,1.35,8.11,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,13.51,9.46,5.41,10.81,1.35,1.35,1.35,1.35,1.35,6.76,1.35,1.35,1.35,1.35,1.35,4.05,1.35,1.35,2.7,1.35,1.35,1.35,1.35,1.35,1.35],"DevOps / SRE / Platform":[1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,6.76,10.81,13.51,5.41,1.35,1.35,1.35,9.46,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,4.05,1.35,1.35,2.7,1.35,1.35,8.11,1.35,1.35,1.35],"Security Engineering / InfoSec":[1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,13.51,10.81,5.41,9.46,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,8.11,1.35,1.35,2.7,1.35,1.35,6.76,1.35,1.35,1.35],"Data Science & Analytics":[1.35,1.35,1.35,1.35,1.35,1.35,1.35,8.11,1.35,13.51,1.35,9.46,5.41,1.35,1.35,10.81,6.76,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,4.05,1.35,1.35,2.7,1.35,1.35,1.35,1.35,1.35,1.35],"Solutions / Sales Engineering":[1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,13.51,1.35,8.11,6.76,10.81,1.35,5.41,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,4.05,1.35,1.35,2.7,1.35,1.35,1.35,1.35,9.46,1.35],"UX / Product Design":[1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,5.41,10.81,9.46,1.35,6.76,13.51,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,4.05,8.11,1.35,2.7,1.35,1.35,1.35,1.35,1.35,1.35],"Supply Chain / Logistics / Category":[1.35,8.11,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,13.51,10.81,1.35,6.76,9.46,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,4.05,1.35,1.35,2.7,1.35,1.35,1.35,1.35,1.35,5.41],"QA / Test Engineering":[1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,13.51,10.81,8.11,9.46,1.35,1.35,6.76,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,4.05,1.35,1.35,2.7,1.35,1.35,5.41,1.35,1.35,1.35],"Hardware / Embedded Engineering":[1.35,6.76,1.35,1.35,1.35,1.35,1.35,9.46,5.41,13.51,1.35,10.81,1.35,1.35,1.35,1.35,8.11,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,4.05,1.35,1.35,2.7,1.35,1.35,1.35,1.35,1.35,1.35],"Technical Program Management":[1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,5.41,13.51,8.11,9.46,10.81,1.35,1.35,1.35,1.35,1.35,6.76,1.35,1.35,1.35,1.35,1.35,4.05,1.35,1.35,2.7,1.35,1.35,1.35,1.35,1.35,1.35],"Clinical / Regulatory Affairs":[1.35,1.35,1.35,1.35,1.35,1.35,1.35,9.46,13.51,1.35,1.35,10.81,8.11,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,6.76,1.35,1.35,2.7,1.35,1.35,1.35,1.35,1.35,5.41],"Strategy / Management Consultant":[1.35,1.35,5.41,1.35,1.35,1.35,1.35,8.11,1.35,1.35,1.35,6.76,13.51,9.46,1.35,10.81,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,4.05,1.35,1.35,2.7,1.35,1.35,1.35,1.35,1.35,1.35],"Sustainability / ESG Specialist":[1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,10.81,1.35,1.35,13.51,9.46,5.41,1.35,6.76,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,4.05,1.35,8.11,2.7,1.35,1.35,1.35,1.35,1.35,1.35],"Public Policy / Government Affairs":[1.35,1.35,1.35,1.35,1.35,1.35,1.35,5.41,1.35,1.35,1.35,13.51,9.46,10.81,1.35,6.76,1.35,1.35,1.35,8.11,1.35,1.35,1.35,1.35,1.35,1.35,1.35,4.05,1.35,1.35,2.7,1.35,1.35,1.35,1.35,1.35,1.35],"Risk / Actuarial / Compliance":[1.35,1.35,1.35,1.35,1.35,1.35,1.35,6.76,13.51,1.35,1.35,10.81,9.46,1.35,1.35,5.41,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,8.11,1.35,1.35,2.7,1.35,1.35,1.35,1.35,1.35,1.35],"Investment / Portfolio (PE/VC/Markets)":[1.35,1.35,6.76,1.35,5.41,1.35,9.46,1.35,1.35,1.35,1.35,10.81,8.11,1.35,1.35,13.51,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,1.35,4.05,1.35,1.35,2.7,1.35,1.35,1.35,1.35,1.35,1.35]},"companyModifiers":{"Services — IT Scale":[1.5,1,1,1.5,1,1,1,1,1.5,1,1,1.5,1.5,1,1,1,1,0.65,1,0.65,1.5,1,1,1,1,1.5,1,1,1,1,1,1,1,1,0.65,1,1],"Services — High-End Eng":[1,1,1,0.65,1,1,1,1,0.65,1.5,1.5,1,1.5,1,1,1,1.5,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1.5,1.5,1,1,1],"Product — Consumer/App":[1,1,1,1,1,1,1,1,0.65,1.5,1.5,1,1,1,1,1.5,1,1,1,1,1,1,1,1,1,1,1,1,1.5,1,1,1,1.5,1.5,1,1,0.65],"Product — Dev/API Tools":[1,1,1,0.65,1,1,1,1,0.65,1.5,1.5,1,1,1,1,1,1.5,1,1,1.5,1,1,1,1,1,1,1,1,1,1,1,1.5,1,1.5,1,1,1],"Product — Enterprise Platform":[1,1.5,1,1,1,1,1,1,1.5,1,1.5,1.5,1.5,1,1,1,1,0.65,1,1,1,1.5,1,1,1,1,1,1,1,1,1,1,1,1,0.65,1,1],"Product — Infra/Cloud/Data":[1,1,1,1,1,1,1,1.5,1,1.5,1.5,1,1,1,1,1.5,1.5,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1.5,1,0.65,0.65],"E-commerce/Marketplace":[1,1,1,0.65,1,1,1,1,1,1.5,1,1,1.5,1,1.5,1.5,1,0.65,1,1,1,1,1,1,1,1,1,1,1,1.5,1,1,1.5,1,1,1,1],"Mid-cap SaaS":[1,1,1,1,1,1,1,1,1,1,1,1.5,1.5,1,1,1.5,1,0.65,1,1,1.5,1,1,1,1,1,1,1,1,1,1,1,1,1.5,0.65,1.5,1],"Frontier AI":[1,1,1,0.65,1,1,1,1.5,0.65,1.5,1,1,1,1,1,1,1.5,1.5,1.5,1.5,1,1,1,1,1,1,1,1,1.5,1,1,1,1,1,1,1,0.65],"Industrial/Embedded AI":[1,1.5,1,1.5,1,1,1,1,1.5,1.5,1,1.5,1.5,1,1,1,1,1,1,0.65,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0.65,1,1],"Fintech Infra/Payments":[1,1,1,1,1,1,1,1,1.5,1.5,1,1.5,1,1,1,1.5,1,1,1,1,1,1,1,1,1,1,1,1.5,1,1,1,1,1,1.5,1,1,0.65],"CRM/GTM-tech":[1,1,1,1,1,1,1,1,1,1,1.5,1.5,1.5,1,1,1.5,1,0.65,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1.5,1,1,1.5,1],"BFSI/Banks":[1,1,1,1.5,1,1,1.5,1,1.5,1,1,1.5,1,1,1,1,1,1,1,0.65,1,1,1,1,1.5,1,1,1.5,1,1,1,1,1,1,0.65,1,1.5],"GCC — Global Capability Center":[1,1,1.5,1.5,1.5,1,1,1,1,1,1,1.5,1.5,1.5,1.5,1.5,1,1,1,1,1,1.5,1,1,1,1,1,1,1,1.5,1,1,1,1,1,1,1],"E-commerce — Quick Commerce":[1,1,1,1,1,1,1,1,1,1,1,1.5,1.5,1,1.5,1.5,1,0.65,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1.5,1,1,1,1],"E-commerce — Fashion/Lifestyle":[1,1,1,1,1,1,1,1,1,1,1,1.5,1.5,1,1,1.5,1,0.65,1,1,1,1,1,1,1,1,1,1,1.5,1.5,1,1,1,1,1,1,1],"Cybersecurity":[1,1,1,1,1,1,1,1,1.5,1.5,1,1.5,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1.5,1,1,1,1,1,1.5,1,1,1],"Datacenter/Cloud Infrastructure":[1,1,1,1.5,1,1,1,1,1.5,1.5,1.5,1.5,1,1,1,1,1,0.65,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],"Manufacturing/Industrial":[1,1.5,1,1.5,1,1,1,1,1.5,1,1,1.5,1.5,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0.65,1,1],"Healthcare/Pharma/Biotech":[1,1,1,1,1,1,1,1.5,1.5,1,1,1.5,1,1,1,1,1,1.5,1,1,1,1,1,1,1,1,1,1.5,1,1,1,1,1,1,1,1,1],"EdTech":[1,1,1,1,1,1,1,1,1,1,1,1.5,1.5,1.5,1,1.5,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1.5,1,1,1,1],"Gaming/Media/Entertainment":[1,1,1,1,1,1,1,1,0.65,1,1,1,1.5,1,1,1.5,1.5,1,1,1,1,1,1,1,1,1,1,1,1.5,1,1,1,1.5,1,1,1,1],"Telecom/Networking":[1,1,1,1.5,1,1,1,1,1.5,1.5,1.5,1.5,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],"Climate / CleanTech / Renewables":[1,1,1,1,1,1,1,1.5,1,1.5,1,1.5,1,1,1,1.5,1,1,1,1,1,1,1,1,1,1,1,1,1.5,1,1,1,1,1,1,1,1],"ESG / Sustainability":[1,1,1,1,1,1,1,1,1.5,1,1,1.5,1.5,1,1,1.5,1,1,1,1,1,1,1,1,1,1,1,1,1,1.5,1,1,1,1,1,1,1],"NGO / Non-profit / Social Impact":[1,1,1,1,0.65,1,1,1,1,1,1,1.5,1.5,1.5,1,1,1,1,1,1,1,1,0.65,1,1,1,1,1,1,1.5,1,1,1.5,1,1,1,1],"Management Consulting (MBB / Big 4)":[1,1,1.5,1,1,1,1.5,1.5,1,1,1,1,1.5,1.5,1,1.5,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],"Government / Public Sector / PSU":[1,1,1,1.5,1,1,1,1,1.5,1,1,1.5,1.5,1,1,1,1,1,1,1,1,1,1,1,1.5,1,1,1,1,1,1,1,1,1,0.65,1,1],"Logistics / Supply Chain / Mobility":[1,1.5,1,1,1,1,1,1,1,1,1,1.5,1.5,1,1.5,1.5,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],"PropTech / Real Estate / Construction":[1,1.5,1,1,1,1,1,1,1.5,1,1,1.5,1.5,1,1,1.5,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],"Travel / Hospitality / Aviation":[1,1,1,1,1,1,1,1,1,1,1,1.5,1.5,1.5,1,1.5,1,1,1,1,1,1,1,1,1,1,1,1,1,1.5,1,1,1,1,1,1,1],"Agritech / FoodTech":[1,1,1,1,1,1,1,1,1,1.5,1,1.5,1.5,1,1,1.5,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1.5,1,1,1,1],"LegalTech / RegTech":[1,1,1,1,1,1,1,1,1.5,1.5,1,1.5,1.5,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1.5,1,1,1,1,1,1,1,1,1],"HRTech / Staffing":[1,1,1,1,1,1,1,1,1,1,1,1.5,1.5,1.5,1,1.5,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1.5,1],"InsurTech / Insurance":[1,1,1,1,1,1,1,1,1.5,1.5,1,1.5,1.5,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1.5,1,1,1,1,1,1,1,1,1],"Crypto / Web3 / Blockchain":[1,1,1,0.65,1,1,1,1,1,1.5,1,1,1,1,1,1,1,1,1,1.5,1,1,1,1,1,1,1,1,1.5,1,1,1,1.5,1.5,1,1,1],"Robotics / Autonomous Systems":[1,1,1,1,1,1,1,1.5,1,1.5,1,1.5,1,1,1,1,1.5,1.5,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],"Aerospace / Space / Defense":[1,1,1,1,1,1,1,1.5,1.5,1.5,1,1.5,1,1,1,1,1,1,1,1,1,1,1,1,1.5,1,1,1,1,1,1,1,1,1,1,1,1],"Automotive / EV / Mobility":[1,1.5,1,1,1,1,1,1,1.5,1.5,1,1.5,1,1,1,1.5,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],"Retail / Omnichannel":[1,1,1,1,1,1,1,1,1,1,1,1.5,1.5,1.5,1.5,1.5,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],"FMCG / CPG":[1,1,1.5,1,1.5,1,1,1,1,1,1,1.5,1.5,1,1,1.5,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],"Medical Devices":[1,1,1,1,1,1,1,1.5,1.5,1.5,1,1.5,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1.5,1,1,1,1,1,1,1,1,1],"Semiconductor / Chip Design":[1,1,1,1,1,1,1,1.5,1,1.5,1,1.5,1,1,1,1,1.5,1.5,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],"Energy / Oil & Gas / Utilities":[1,1.5,1,1.5,1,1,1,1,1.5,1.5,1,1.5,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],"NBFC / Lending / Fintech-Lending":[1,1,1,1,1,1,1,1,1.5,1,1,1.5,1.5,1,1,1.5,1,1,1,1,1,1,1,1,1,1,1,1.5,1,1,1,1,1,1,1,1,1],"Capital Markets / PE / VC / Hedge Fund":[1,1,1,1,1.5,1,1.5,1.5,1,1,1,1.5,1,1,1,1.5,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],"Advertising / Creative Agency":[1,1,1,1,1,1,1,1,1,1,1,1,1.5,1.5,1,1.5,1.5,1,1,1,1,1,1,1,1,1,1,1,1.5,1,1,1,1,1,1,1,1],"DeepTech / Hard-science Startup":[1,1,1,1,1,1,1,1.5,1,1.5,1,1,1,1,1,1,1.5,1.5,1,1,1,1,1,1,1,1,1,1,1.5,1,1,1,1,1,1,1,1],"Research / Academia / Think Tank":[1,1,1,1,1,1,1,1.5,1,1,1,1.5,1,1,1,1,1,1.5,1.5,1.5,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],"AI — Fintech / Risk":[1,1,1,1,1,1,1,1,1,1.5,1,1.5,1,1,1,1.5,1,1,1,1,1,1,1,1,1,1,1,1.5,1,1,1,1,1,1.5,1,1,1],"AI — Healthcare / Bio":[1,1,1,1,1,1,1,1,1.5,1.5,1,1.5,1,1,1,1,1,1.5,1,1,1,1,1,1,1,1,1,1.5,1,1,1,1,1,1,1,1,1],"AI — Real Estate / PropTech":[1,1,1,1,1,1,1,1,1,1.5,1,1.5,1,1,1,1.5,1.5,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1.5,1,1,1,1],"AI — Retail / Commerce":[1,1,1,1,1,1,1,1,1,1.5,1,1.5,1,1,1,1.5,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1.5,1.5,1,1,1],"AI — Legal / RegTech":[1,1,1,1,1,1,1,1,1.5,1.5,1,1.5,1.5,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1.5,1,1,1,1,1,1,1,1,1],"AI — Public Sector / GovTech":[1,1,1,1,1,1,1,1,1.5,1.5,1,1.5,1,1,1,1,1,1,1,1,1,1,1,1,1.5,1,1,1.5,1,1,1,1,1,1,1,1,1],"AI — Cybersecurity":[1,1,1,1,1,1,1,1,1.5,1.5,1,1.5,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1.5,1,1,1,1,1,1.5,1,1,1]}};
  function rubricScore(role, company, threshold, gate, scores) {
    var cats = ENGINE.categories, ri = ENGINE.roleWeights[role] || ENGINE.roleWeights['General'], ci = ENGINE.companyModifiers[company] || ENGINE.companyModifiers['Mid-cap SaaS'];
    var raw = [], tot = 0; cats.forEach(function (c, i) { raw[i] = (ri[i] || 0) * (ci[i] || 1); tot += raw[i]; });
    var comp = 0, eff = {}; cats.forEach(function (c, i) { var w = tot ? raw[i] / tot * 100 : 0; eff[c] = Math.round(w * 100) / 100; comp += w * (scores[c] || 0) / 5; });
    var min = ENGINE.thresholds[threshold] || 65, verdict;
    if (gate === false) verdict = 'REJECT - gate fail'; else if (comp >= min) verdict = 'SHORTLIST'; else if (comp >= min - 12) verdict = 'REVIEW'; else verdict = 'REJECT';
    var top = Object.keys(eff).sort(function (a, b) { return eff[b] - eff[a]; }).slice(0, 5);
    return { composite: Math.round(comp * 10) / 10, minRequired: min, verdict: verdict, effectiveWeights: eff, topCategories: top };
  }

  /* ------------------------------------------------------------------ people */
  var RECRUITER = { name: 'Jordan Blake', title: 'Senior Talent Partner', email: 'jordan.blake@example.com' };
  var TEAM = [
    { email: 'jordan.blake@example.com', name: 'Jordan Blake', role: 'Admin', title: 'Senior Talent Partner' },
    { email: 'nina.castell@example.com', name: 'Nina Castell', role: 'Recruiter', title: 'Recruiter' },
    { email: 'maya.ellison@example.com', name: 'Maya Ellison', role: 'HiringManager', title: 'Director, Platform Engineering' },
    { email: 'theo.varga@example.com', name: 'Theo Varga', role: 'HiringManager', title: 'Head of Design' },
    { email: 'priya.raman@example.com', name: 'Priya Raman', role: 'HiringManager', title: 'Analytics Lead' },
    { email: 'daniel.okafor@example.com', name: 'Daniel Okafor', role: 'HiringManager', title: 'VP Engineering' },
    { email: 'lena.fischer@example.com', name: 'Lena Fischer', role: 'HiringManager', title: 'Director, Customer Success' },
    { email: 'arjun.mehta@example.com', name: 'Arjun Mehta', role: 'Interviewer', title: 'Staff Engineer' },
    { email: 'ines.calder@example.com', name: 'Ines Calder', role: 'Interviewer', title: 'Senior Engineer' },
    { email: 'kai.morgan@example.com', name: 'Kai Morgan', role: 'Interviewer', title: 'Senior Product Designer' }
  ];
  var HMS = [
    { name: 'Maya Ellison', email: 'maya.ellison@example.com' }, { name: 'Theo Varga', email: 'theo.varga@example.com' },
    { name: 'Priya Raman', email: 'priya.raman@example.com' }, { name: 'Daniel Okafor', email: 'daniel.okafor@example.com' },
    { name: 'Lena Fischer', email: 'lena.fischer@example.com' }, { name: 'Sam Whitaker', email: 'sam.whitaker@example.com' }
  ];

  /* ------------------------------------------------------------------ requisitions */
  function plan(rounds) { return JSON.stringify({ rounds: rounds }); }
  var REQS = [
    { id: 'REQ-101', title: 'Senior Backend Engineer', department: 'Engineering', lob: 'Platform Engineering', location: 'Bengaluru (Hybrid)', employment: 'Full-time', level: 'Senior', hm: 'Maya Ellison', hmEmail: 'maya.ellison@example.com', recruiter: 'Jordan Blake', openings: 2, priority: 'High', status: 'Open', salaryMin: 3200000, salaryMax: 5500000, opened: 38,
      notes: 'Own core services on the event-driven order platform (Go/Java, Kafka, PostgreSQL on Kubernetes). Two openings — one payments-adjacent, one platform.',
      interviewers: ['Maya Ellison', 'Arjun Mehta', 'Ines Calder'],
      rubric: { role: 'Senior Technical IC', company: 'Mid-cap SaaS', threshold: 'Balanced' }, fitArch: 'Product company',
      must: [{ label: 'Go or Java services in production', keys: ['go', 'java', 'golang'] }, { label: 'Distributed systems / microservices', keys: ['distributed systems', 'microservices', 'grpc', 'event sourcing'] }, { label: 'PostgreSQL or equivalent RDBMS', keys: ['postgresql', 'postgres', 'mysql', 'oracle'] }, { label: 'Kafka / event streaming', keys: ['kafka', 'event sourcing', 'event streaming'] }, { label: 'Cloud & Kubernetes', keys: ['kubernetes', 'aws', 'gcp', 'terraform'] }],
      nice: ['Payments or fintech domain', 'Observability (Prometheus/OpenTelemetry)', 'Mentoring juniors'], flags: ['Job-hopping under 1 year', 'Only CRUD/monolith experience'],
      sp: { exp_min: 5, exp_ideal: 7, exp_max: 10, core_skills: ['Go', 'Java', 'Kafka', 'PostgreSQL', 'Kubernetes', 'Distributed systems', 'AWS', 'gRPC'], market_note: 'Senior backend talent with Kafka + Go is tight in Bengaluru; expect 60–90 day notice periods and counter-offers. Payments experience commands a 10–15% premium.', summary: 'Builds and owns high-throughput services end-to-end; strong on reliability and data modelling.' },
      plan: plan([{ name: 'Screening', type: 'recruiter', competencies: ['Motivation', 'Logistics', 'Comp alignment'] }, { name: 'Technical', type: 'technical', competencies: ['Go/Java depth', 'Concurrency', 'SQL'] }, { name: 'System Design', type: 'technical', competencies: ['Distributed systems', 'Event streaming', 'Trade-offs'] }, { name: 'Hiring Manager', type: 'hiring_manager', competencies: ['Ownership', 'Collaboration', 'Growth'] }]) },
    { id: 'REQ-102', title: 'Product Designer', department: 'Product', lob: 'Product Design', location: 'Remote (India)', employment: 'Full-time', level: 'Mid', hm: 'Theo Varga', hmEmail: 'theo.varga@example.com', recruiter: 'Jordan Blake', openings: 1, priority: 'Medium', status: 'Open', salaryMin: 1800000, salaryMax: 3000000, opened: 33,
      notes: 'Design the analytics and admin surfaces of our B2B product. Strong systems thinking; comfortable running lightweight research.',
      interviewers: ['Theo Varga', 'Kai Morgan'],
      rubric: { role: 'UX / Product Design', company: 'Mid-cap SaaS', threshold: 'Balanced' }, fitArch: 'Product company',
      must: [{ label: 'Figma & high-fidelity prototyping', keys: ['figma', 'prototyping', 'framer'] }, { label: 'Design systems', keys: ['design systems'] }, { label: 'User research & usability testing', keys: ['user research', 'usability testing'] }, { label: 'B2B / SaaS product experience', keys: ['b2b saas', 'dashboards', 'data viz'] }],
      nice: ['Accessibility (WCAG)', 'Data visualisation'], flags: ['Portfolio is only visual/brand work'],
      sp: { exp_min: 3, exp_ideal: 5, exp_max: 8, core_skills: ['Figma', 'Design systems', 'User research', 'Prototyping', 'B2B SaaS', 'Accessibility'], market_note: 'Mid-level product designers with B2B depth are available; portfolio quality varies widely — screen on case studies, not dribbble shots.', summary: 'End-to-end product designer who can turn messy data workflows into clear interfaces.' },
      plan: plan([{ name: 'Screening', type: 'recruiter', competencies: ['Motivation', 'Logistics'] }, { name: 'Portfolio Review', type: 'case', competencies: ['Craft', 'Process', 'Storytelling'] }, { name: 'Design Exercise', type: 'case', competencies: ['Problem framing', 'Interaction design'] }, { name: 'Hiring Manager', type: 'hiring_manager', competencies: ['Collaboration', 'Ownership'] }]) },
    { id: 'REQ-103', title: 'Data Analyst', department: 'Data', lob: 'Data & Insights', location: 'Pune', employment: 'Full-time', level: 'Mid', hm: 'Priya Raman', hmEmail: 'priya.raman@example.com', recruiter: 'Nina Castell', openings: 2, priority: 'Medium', status: 'Open', salaryMin: 1200000, salaryMax: 2200000, opened: 58,
      notes: 'Partner with growth and product teams on experimentation and self-serve dashboards.',
      interviewers: ['Priya Raman', 'Ines Calder'],
      rubric: { role: 'Data Science & Analytics', company: 'Mid-cap SaaS', threshold: 'Balanced' }, fitArch: 'Product company',
      must: [{ label: 'Advanced SQL', keys: ['sql'] }, { label: 'Python for analysis', keys: ['python', 'r'] }, { label: 'BI tooling (Looker / Tableau / Power BI)', keys: ['looker', 'tableau', 'power bi'] }, { label: 'A/B testing & statistics', keys: ['a/b testing', 'statistics', 'experimentation'] }],
      nice: ['dbt / analytics engineering', 'Stakeholder storytelling'], flags: ['Only Excel reporting'],
      sp: { exp_min: 2, exp_ideal: 4, exp_max: 7, core_skills: ['SQL', 'Python', 'Looker', 'Tableau', 'A/B testing', 'dbt', 'Statistics'], market_note: 'Healthy supply in Pune; the differentiator is experimentation rigour, not tooling.', summary: 'Analyst who can frame a question, query it, and tell the story to non-technical partners.' },
      plan: plan([{ name: 'Screening', type: 'recruiter', competencies: ['Motivation'] }, { name: 'SQL Assessment', type: 'technical', competencies: ['SQL', 'Data modelling'] }, { name: 'Case Study', type: 'case', competencies: ['Experimentation', 'Storytelling'] }, { name: 'Hiring Manager', type: 'hiring_manager', competencies: ['Stakeholder management'] }]) },
    { id: 'REQ-104', title: 'Engineering Manager', department: 'Engineering', lob: 'Core Engineering', location: 'Bengaluru', employment: 'Full-time', level: 'Manager', hm: 'Daniel Okafor', hmEmail: 'daniel.okafor@example.com', recruiter: 'Jordan Blake', openings: 1, priority: 'High', status: 'Open', salaryMin: 5000000, salaryMax: 7500000, opened: 41,
      notes: 'Lead a team of 8 engineers across two squads; partner with product on roadmap; own hiring and delivery health.',
      interviewers: ['Daniel Okafor', 'Maya Ellison', 'Arjun Mehta'],
      rubric: { role: 'Engineering Leadership', company: 'Mid-cap SaaS', threshold: 'Balanced' }, fitArch: 'Product company',
      must: [{ label: 'People leadership (5+ reports)', keys: ['people leadership', 'mentoring', 'team leadership'] }, { label: 'Hiring & team building', keys: ['hiring', 'org design'] }, { label: 'Delivery management', keys: ['delivery management', 'agile delivery', 'okrs'] }, { label: 'Hands-on distributed systems background', keys: ['distributed systems', 'microservices', 'platform strategy'] }],
      nice: ['Fintech or payments', 'Scaled a team from <5 to 10+'], flags: ['No direct reports in last 3 years'],
      sp: { exp_min: 8, exp_ideal: 11, exp_max: 15, core_skills: ['People leadership', 'Hiring', 'Delivery management', 'Distributed systems', 'OKRs', 'Stakeholder management'], market_note: 'Strong EMs are usually passive candidates — referrals convert 3× better than inbound for this role.', summary: 'Player-coach EM who grows people and keeps delivery predictable.' },
      plan: plan([{ name: 'Screening', type: 'recruiter', competencies: ['Motivation', 'Scope'] }, { name: 'Leadership', type: 'behavioral', competencies: ['Coaching', 'Conflict', 'Hiring'] }, { name: 'System Design', type: 'technical', competencies: ['Architecture judgement'] }, { name: 'Hiring Manager', type: 'hiring_manager', competencies: ['Strategy', 'Culture add'] }]) },
    { id: 'REQ-105', title: 'Customer Success Lead', department: 'Customer Success', lob: 'Customer Success', location: 'Hyderabad (Hybrid)', employment: 'Full-time', level: 'Lead', hm: 'Lena Fischer', hmEmail: 'lena.fischer@example.com', recruiter: 'Nina Castell', openings: 1, priority: 'Medium', status: 'Open', salaryMin: 2000000, salaryMax: 3500000, opened: 64,
      notes: 'Lead a pod of 4 CSMs covering mid-market accounts; own renewals, onboarding playbooks and churn reduction.',
      interviewers: ['Lena Fischer', 'Nina Castell'],
      rubric: { role: 'Customer Success & Support', company: 'Mid-cap SaaS', threshold: 'Balanced' }, fitArch: 'Product company',
      must: [{ label: 'B2B SaaS customer success', keys: ['b2b saas', 'healthcare saas', 'qbrs'] }, { label: 'Renewals & expansion ownership', keys: ['renewals', 'upsell'] }, { label: 'Team leadership', keys: ['team leadership'] }, { label: 'Onboarding & churn reduction', keys: ['onboarding', 'churn reduction', 'customer onboarding'] }],
      nice: ['Gainsight / CS platform', 'Mid-market accounts'], flags: ['Pure support/ticketing background'],
      sp: { exp_min: 5, exp_ideal: 7, exp_max: 11, core_skills: ['B2B SaaS', 'Renewals', 'Team leadership', 'Onboarding', 'Churn reduction', 'Gainsight'], market_note: 'CS leads with renewal ownership are in demand; many senior CSMs have never managed people — probe this early.', summary: 'Commercially minded CS leader who coaches a team and owns net revenue retention.' },
      plan: plan([{ name: 'Screening', type: 'recruiter', competencies: ['Motivation'] }, { name: 'Role Play', type: 'case', competencies: ['Renewal conversation', 'Escalation handling'] }, { name: 'Panel', type: 'behavioral', competencies: ['Leadership', 'Cross-functional work'] }, { name: 'Hiring Manager', type: 'hiring_manager', competencies: ['Strategy'] }]) },
    { id: 'REQ-106', title: 'Site Reliability Engineer', department: 'Engineering', lob: 'Platform Engineering', location: 'Bengaluru', employment: 'Full-time', level: 'Mid', hm: 'Sam Whitaker', hmEmail: 'sam.whitaker@example.com', recruiter: 'Jordan Blake', openings: 1, priority: 'Low', status: 'Open', salaryMin: 2400000, salaryMax: 4000000, opened: 2,
      notes: 'New role — on-call rotation for the order platform, SLOs, incident response and Terraform-managed infra.',
      interviewers: ['Arjun Mehta'], rubric: { role: 'DevOps / SRE / Platform', company: 'Mid-cap SaaS', threshold: 'Balanced' }, fitArch: 'Product company',
      must: [{ label: 'Kubernetes in production', keys: ['kubernetes'] }, { label: 'Infrastructure as code', keys: ['terraform'] }, { label: 'Observability', keys: ['prometheus'] }],
      nice: [], flags: [], noCalibration: true,
      sp: { exp_min: 3, exp_ideal: 5, exp_max: 9, core_skills: ['Kubernetes', 'Terraform', 'Prometheus', 'AWS', 'Go', 'Incident response'], market_note: 'SRE supply is thin; consider strong platform engineers who have carried a pager.', summary: 'Reliability-first engineer who automates toil away.' },
      plan: '' }
  ];
  var REQ = {}; REQS.forEach(function (r) { REQ[r.id] = r; });

  /* ------------------------------------------------------------------ candidates
     [id, name, req, stage, source, receivedDaysAgo, daysInStage, location, title, company, exp, skills, qualification,
      currentCTC, expectedCTC, notice, gender, aiFit, note] */
  var RAW = [
    ['C-1001', 'Aarav Menon', 'REQ-101', 'Debrief', 'LinkedIn', 21, 2, 'Bengaluru', 'Senior Software Engineer', 'Kestrel Cloud', 8, 'Go, Kafka, PostgreSQL, Kubernetes, gRPC, AWS, Distributed systems', 'B.Tech Computer Science — Westbrook Institute of Technology (2017)', 3600000, 4800000, 60, 'Male', 91, 'Built Kestrel Cloud\'s event ingestion tier (Go + Kafka, 40k msg/s); led a Postgres-to-partitioned-tables migration with zero downtime.'],
    ['C-1002', 'Elena Duarte', 'REQ-101', 'Interview Scheduled', 'Referral', 12, 3, 'Bengaluru', 'Backend Engineer II', 'Halcyon Pay', 6, 'Java, Spring Boot, Kafka, PostgreSQL, Redis, AWS, Microservices', 'B.E. Information Technology — Ridgeview University (2019)', 3000000, 4200000, 30, 'Female', 86, 'Owns the settlement service at Halcyon Pay; strong payments domain and idempotency patterns.'],
    ['C-1003', 'Rohan Iyer', 'REQ-101', 'Shortlist', 'Careers page', 9, 4, 'Hyderabad', 'Senior Engineer', 'Brightloop', 7, 'Go, Distributed systems, DynamoDB, Terraform, AWS, Microservices', 'M.Tech Software Systems — Lakeshore University (2018)', 3400000, 4600000, 90, 'Male', 82, 'Solid Go and AWS depth; uses DynamoDB rather than Postgres — probe relational modelling.'],
    ['C-1004', 'Mei Lin Zhao', 'REQ-101', 'Offered', 'LinkedIn', 34, 2, 'Bengaluru', 'Software Engineer III', 'Vellum Systems', 9, 'Rust, Go, PostgreSQL, Kafka, Event sourcing, Kubernetes, Distributed systems', 'B.S. Computer Engineering — Westbrook Institute of Technology (2016)', 4200000, 5200000, 60, 'Female', 88, 'Designed Vellum\'s event-sourced ledger; mentors three engineers; excellent system-design round.'],
    ['C-1005', 'Kofi Asante', 'REQ-101', 'Screened', 'Job board', 6, 2, 'Remote', 'Platform Engineer', 'Orbita', 5, 'Python, Kubernetes, Kafka, GCP, Terraform', 'B.Sc. Computer Science — Southgate University (2020)', 2400000, 3300000, 30, 'Male', 71, 'Strong platform/Kubernetes background; backend work mostly in Python — Go/Java would be a ramp.'],
    ['C-1006', 'Sofia Marchetti', 'REQ-101', 'New', 'Careers page', 2, 2, 'Pune', 'Backend Developer', 'Tidewell Commerce', 4, 'Node.js, MongoDB, Express, AWS Lambda', 'B.E. Computer Engineering — Ridgeview University (2021)', 1800000, 2600000, 45, 'Female', 58, 'Node/Mongo serverless experience; limited exposure to streaming or relational modelling.'],
    ['C-1007', 'Vikram Shetty', 'REQ-101', 'New', 'Agency', 3, 3, 'Bengaluru', 'Principal Engineer', 'Craneworks', 15, 'Java, C++, Microservices, Oracle, Team leadership, Distributed systems', 'M.S. Computer Science — Lakeshore University (2010)', 6200000, 7000000, 90, 'Male', 74, 'Deep Java/distributed-systems experience but 15 yrs and principal-level scope — likely over-qualified and above budget.'],
    ['C-1008', 'Hannah Okoro', 'REQ-101', 'CV Screen Reject', 'Job board', 15, 12, 'Chennai', 'Junior Developer', 'Fernhollow', 2, 'PHP, Laravel, MySQL', 'B.Sc. Information Systems — Southgate University (2023)', 900000, 1400000, 15, 'Female', 34, 'Early-career PHP developer; does not meet the senior bar for this role.'],
    ['C-1009', 'Diego Ramos', 'REQ-101', 'Interview', 'Referral', 18, 11, 'Bengaluru', 'Senior Backend Engineer', 'Northwind Labs', 7, 'Go, PostgreSQL, Kafka, Kubernetes, AWS, gRPC', 'B.Tech Computer Science — Ridgeview University (2018)', 3500000, 4700000, 60, 'Male', 84, 'Runs Northwind Labs\' order-routing services in Go; good Kafka consumer-group tuning stories.'],
    ['C-1010', 'Isla Brennan', 'REQ-102', 'Debrief', 'LinkedIn', 25, 1, 'Remote', 'Product Designer', 'Quantiva', 5, 'Figma, Design systems, User research, Prototyping, B2B SaaS, Accessibility', 'B.Des Interaction Design — Southgate College of Design (2019)', 2200000, 2800000, 30, 'Female', 89, 'Led Quantiva\'s design-system rebuild (120+ components) and the redesign of their reporting module.'],
    ['C-1011', 'Noah Petrov', 'REQ-102', 'Interview', 'Careers page', 14, 5, 'Bengaluru', 'UX Designer', 'Lumora Health', 4, 'Figma, Usability testing, Accessibility, Healthcare, Prototyping', 'M.Des Human-Computer Interaction — Lakeshore University (2020)', 1900000, 2500000, 60, 'Male', 76, 'Strong research and accessibility practice from healthcare; less B2B analytics exposure.'],
    ['C-1012', 'Amara Nwosu', 'REQ-102', 'Screened', 'Agency', 8, 3, 'Mumbai', 'Senior Visual Designer', 'Brightloop', 6, 'Branding, Illustration, Figma, Motion', 'B.F.A. Communication Design — Southgate College of Design (2018)', 2000000, 2700000, 30, 'Female', 61, 'Excellent visual craft; portfolio is mostly brand and marketing work rather than product flows.'],
    ['C-1013', 'Lucas Moreau', 'REQ-102', 'New', 'Careers page', 4, 4, 'Remote', 'Interaction Designer', 'Orbita', 3, 'Figma, Prototyping, Framer, Design systems', 'B.Des Product Design — Southgate College of Design (2021)', 1500000, 2100000, 30, 'Male', 72, 'Polished prototyping in Framer; contributed to Orbita\'s component library.'],
    ['C-1014', 'Freya Lindqvist', 'REQ-102', 'Interview Reject', 'Job board', 30, 9, 'Remote', 'Product Designer', 'Pinecrest Analytics', 4, 'Figma, Data viz, Dashboards', 'B.A. Visual Communication — Ridgeview University (2020)', 1700000, 2400000, 60, 'Female', 66, 'Good dashboard work; design exercise lacked problem framing and research.'],
    ['C-1015', 'Ananya Rao', 'REQ-103', 'Onboarded', 'Referral', 52, 6, 'Pune', 'Data Analyst', 'Pinecrest Analytics', 4, 'SQL, Python, Looker, A/B testing, dbt, Statistics', 'M.Sc. Statistics — Lakeshore University (2020)', 1500000, 1900000, 30, 'Female', 87, 'Ran 40+ experiments at Pinecrest; built their self-serve Looker layer on dbt.'],
    ['C-1016', 'Marcus Bell', 'REQ-103', 'Offered', 'LinkedIn', 28, 2, 'Pune', 'Business Analyst', 'Tidewell Commerce', 3, 'SQL, Excel, Tableau, Stakeholder management, A/B testing', 'B.Com — Ridgeview University (2021)', 1100000, 1600000, 30, 'Male', 73, 'Great stakeholder communication; SQL solid, Python light — fine for the second opening.'],
    ['C-1017', 'Zara Haddad', 'REQ-103', 'Interview Scheduled', 'Careers page', 10, 2, 'Pune', 'Analytics Engineer', 'Kestrel Cloud', 5, 'SQL, dbt, Python, Airflow, Looker, Statistics', 'B.Tech Computer Science — Westbrook Institute of Technology (2019)', 1900000, 2300000, 60, 'Female', 85, 'Analytics-engineering depth (dbt + Airflow) with a strong experimentation case study.'],
    ['C-1018', 'Tomás Ortega', 'REQ-103', 'Shortlist', 'Job board', 7, 3, 'Pune', 'Junior Data Analyst', 'Craneworks', 2, 'SQL, Power BI, Excel', 'B.Sc. Mathematics — Southgate University (2022)', 700000, 1100000, 15, 'Male', 62, 'Quick learner with good SQL fundamentals; light on Python and experimentation.'],
    ['C-1019', 'Priyanka Das', 'REQ-103', 'New', 'LinkedIn', 1, 1, 'Bengaluru', 'Data Scientist', 'Lumora Health', 6, 'Python, R, Statistics, Machine learning, SQL', 'M.Sc. Data Science — Lakeshore University (2018)', 2300000, 2700000, 90, 'Female', 79, 'Strong statistics and modelling; expected CTC above band and 90-day notice.'],
    ['C-1020', 'Owen Gallagher', 'REQ-103', 'New', 'Job board', 5, 5, 'Nagpur', 'Reporting Analyst', 'Fernhollow', 3, 'Excel, SQL, Google Sheets', 'B.B.A. — Ridgeview University (2021)', 800000, 1200000, 30, 'Male', 55, 'Reporting-focused; little experimentation or BI-tool exposure.'],
    ['C-1021', 'Ritika Malhotra', 'REQ-104', 'Debrief', 'Referral', 26, 4, 'Bengaluru', 'Engineering Manager', 'Halcyon Pay', 11, 'People leadership, Hiring, Java, Distributed systems, OKRs, Delivery management', 'B.Tech Electronics — Westbrook Institute of Technology (2014)', 5600000, 6800000, 90, 'Female', 90, 'Grew Halcyon Pay\'s payments team from 4 to 11; strong delivery metrics and two promoted reports.'],
    ['C-1022', 'Benjamin Clarke', 'REQ-104', 'Interview', 'LinkedIn', 16, 2, 'Bengaluru', 'Senior Engineering Manager', 'Northwind Labs', 14, 'People leadership, Platform strategy, Go, Org design, Hiring', 'M.S. Computer Science — Lakeshore University (2011)', 7200000, 8200000, 60, 'Male', 83, 'Runs a 20-person platform org; may find a single-team EM scope too narrow.'],
    ['C-1023', 'Leila Farahani', 'REQ-104', 'Screened', 'Careers page', 9, 4, 'Bengaluru', 'Tech Lead', 'Vellum Systems', 9, 'Python, Mentoring, Microservices, Agile delivery', 'B.E. Computer Science — Ridgeview University (2016)', 4000000, 5200000, 60, 'Female', 72, 'Strong tech lead with informal mentoring; first formal people-management role.'],
    ['C-1024', 'Gabriel Santos', 'REQ-104', 'On Hold', 'Agency', 33, 12, 'Remote', 'Engineering Manager', 'Quantiva', 10, 'People leadership, Delivery management, Node.js, Hiring', 'B.Sc. Computer Science — Southgate University (2015)', 5200000, 6400000, 60, 'Male', 78, 'Capable EM; panel split on technical depth — parked while Ritika\'s debrief completes.'],
    ['C-1025', 'Chloe Turner', 'REQ-104', 'Rejected', 'Job board', 20, 14, 'Bengaluru', 'Software Engineer', 'Orbita', 5, 'Java, Spring', 'B.Tech Information Technology — Ridgeview University (2020)', 2200000, 3500000, 30, 'Female', 38, 'IC engineer without management experience — not a fit for this level.'],
    ['C-1026', 'Imani Brooks', 'REQ-105', 'Onboarded', 'Referral', 60, 10, 'Hyderabad', 'Customer Success Manager', 'Brightloop', 7, 'B2B SaaS, Renewals, Onboarding, Gainsight, Churn reduction, Team leadership', 'MBA — Lakeshore University (2017)', 2400000, 3000000, 30, 'Female', 88, 'Cut logo churn 30% at Brightloop with a new onboarding playbook; led a 3-person pod.'],
    ['C-1027', 'Nikhil Bansal', 'REQ-105', 'Offer Declined', 'LinkedIn', 40, 8, 'Hyderabad', 'Account Manager', 'Tidewell Commerce', 6, 'Upsell, Renewals, Salesforce, Customer onboarding', 'B.Com — Ridgeview University (2018)', 2100000, 2900000, 60, 'Male', 74, 'Accepted a counter-offer from his current employer.'],
    ['C-1028', 'Sarah Kowalski', 'REQ-105', 'Interview Scheduled', 'Referral', 11, 1, 'Hyderabad', 'Senior CSM', 'Quantiva', 8, 'B2B SaaS, Team leadership, Renewals, Churn reduction, QBRs, Gainsight', 'B.A. Economics — Southgate University (2016)', 2600000, 3200000, 30, 'Female', 86, 'Owns a $3M renewal book at Quantiva; acting lead for two CSMs.'],
    ['C-1029', 'Mateo Fernández', 'REQ-105', 'Shortlist', 'Job board', 8, 2, 'Bengaluru', 'Support Team Lead', 'Kestrel Cloud', 6, 'Zendesk, Team leadership, SLAs, Escalations, Onboarding', 'B.Sc. Computer Science — Ridgeview University (2018)', 1800000, 2500000, 30, 'Male', 69, 'Strong people leader from support; renewal/commercial ownership is unproven.'],
    ['C-1030', 'Grace Adeyemi', 'REQ-105', 'New', 'Careers page', 3, 3, 'Hyderabad', 'Customer Success Associate', 'Lumora Health', 3, 'Onboarding, CRM, Healthcare SaaS', 'B.B.A. — Southgate University (2021)', 900000, 1400000, 30, 'Female', 57, 'Promising early-career CSM; not yet at lead level.'],
    ['C-1031', 'Yusuf Karimi', '', 'Talent Pool', 'Talent Pool', 75, 75, 'Bengaluru', 'Site Reliability Engineer', 'Craneworks', 6, 'Kubernetes, Terraform, Prometheus, AWS, Go, Incident response', 'B.Tech Computer Science — Westbrook Institute of Technology (2019)', 2900000, 3700000, 60, 'Male', 80, 'Strong SRE saved to the talent pool last quarter — ideal for the new REQ-106.'],
    ['C-1032', 'Helena Cruz', '', 'Talent Pool', 'Talent Pool', 90, 90, 'Bengaluru', 'Senior Backend Engineer', 'Orbita', 8, 'Go, Kafka, PostgreSQL, gRPC, Kubernetes', 'B.E. Computer Science — Lakeshore University (2017)', 3800000, 4800000, 60, 'Female', 83, 'Silver-medallist from a previous backend search; Go + Kafka match is very close.']
  ];
  var MISSING = { 'C-1006': ['Notice Period'], 'C-1020': ['Current CTC'] }; // a couple of incomplete profiles to show the nudge
  var CANDS = RAW.map(function (r) {
    var parts = r[1].split(' ');
    var c = { candId: r[0], name: r[1], reqId: r[2], stage: r[3], source: r[4], received: daysAgo(r[5], 9 + (hash(r[0]) % 8), (hash(r[1]) % 4) * 15), inStage: r[6],
      location: r[7], title: r[8], company: r[9], exp: r[10], skills: r[11], qual: r[12], ctc: r[13], ectc: r[14], notice: r[15], gender: r[16], fit: r[17], note: r[18],
      email: parts.join('.').toLowerCase().replace(/[^a-z.]/g, '') + '@example.com', phone: '+1 555 01' + r[0].slice(-2),
      firstName: parts[0], lastName: parts[parts.length - 1], middleName: parts.length > 2 ? parts.slice(1, -1).join(' ') : '',
      hasCv: r[0] !== 'C-1020', offerInHand: (r[0] === 'C-1007' || r[0] === 'C-1022') ? 'Yes' : 'No',
      workmode: ['Hybrid', 'Remote', 'Onsite'][hash(r[0]) % 3], relocate: hash(r[1]) % 2 ? 'Yes' : 'No',
      reason: ['Looking for larger scope and ownership', 'Wants to work on a product with real scale', 'Team restructuring at current employer', 'Seeking a role closer to home', 'Career growth into a lead role'][hash(r[0]) % 5],
      remarks: '' };
    (MISSING[c.candId] || []).forEach(function (k) { if (k === 'Notice Period') c.notice = ''; if (k === 'Current CTC') c.ctc = ''; });
    c.lastChange = daysAgo(c.inStage, 11, 0);
    return c;
  });
  var CAND = {}; CANDS.forEach(function (c) { CAND[c.candId] = c; });
  CAND['C-1001'].remarks = 'HM keen — fast-track if debrief is positive.';
  CAND['C-1004'].remarks = 'Verbal accept expected this week; counter-offer risk is low.';
  CAND['C-1021'].remarks = 'Has a competing offer; decision needed by Friday.';
  CAND['C-1001'].highlights = 'Speaker at a regional Go meetup; maintains a small open-source Kafka testing library.';
  CAND['C-1004'].highlights = 'Two internal tech talks on event sourcing; mentor in Vellum\'s graduate programme.';
  CAND['C-1010'].highlights = 'Case study: reporting redesign cut time-to-insight by 35%.';

  function req(id) { return REQ[id] || null; }
  function reqCands(id) { return CANDS.filter(function (c) { return c.reqId === id; }); }
  function plannedRounds(r) { try { return (JSON.parse((r && r.plan) || '{}').rounds || []).map(function (x) { return x.name; }); } catch (e) { return []; } }

  /* ------------------------------------------------------------------ interviews & feedback (generated, deterministic) */
  var INTERVIEWS = [], FEEDBACK = [], ivSeq = 0;
  var DONE_ROUNDS = { 'Interview Scheduled': 1, 'Interview': 2, 'Interview Reject': 2, 'Debrief': 3, 'On Hold': 3, 'Debrief Reject': 3, 'Selected': 4, 'Offered': 4, 'Offer Declined': 4, 'Onboarded': 4 };
  var NO_FEEDBACK = { 'C-1009': 1, 'C-1011': 1, 'C-1022': 1 }; // interviewed, feedback still outstanding
  var REC_BY = function (score) { return score >= 4.5 ? 'Strong Yes' : score >= 4 ? 'Yes' : score >= 3.5 ? 'Lean Yes' : score >= 3 ? 'Lean No' : 'No'; };
  var POS = ['clear, structured communication', 'strong ownership mindset', 'good depth on fundamentals', 'thoughtful trade-off reasoning', 'asked sharp questions about the team', 'concrete, measurable examples'];
  var NEG = ['could go deeper on failure modes', 'examples skewed to individual work', 'light on stakeholder management', 'notice period is long', 'some gaps in the core stack', 'tended to over-index on tooling'];
  CANDS.forEach(function (c) {
    var r = req(c.reqId); if (!r) return; var rounds = plannedRounds(r); var done = DONE_ROUNDS[c.stage] || 0; if (!done) return;
    var span = Math.max(2, c.inStage + 2), total = Math.max(c.inStage + 3, Math.min(c.inStage + 3 * done + 2, 40));
    for (var i = 0; i < done && i < rounds.length; i++) {
      var ago = c.inStage + (done - i) * 2; if (c.stage === 'Interview Scheduled') ago = c.inStage + 2;
      var when = daysAgo(ago, 10 + (i * 2) % 7, 30);
      var ivr = r.interviewers[i % r.interviewers.length];
      ivSeq++;
      INTERVIEWS.push({ id: 'INT-' + ('00' + ivSeq).slice(-3), candId: c.candId, reqId: c.reqId, stage: rounds[i], interviewers: ivr.split(' ')[0].toLowerCase() + '.' + ivr.split(' ')[1].toLowerCase() + '@example.com', when: when, eventId: 'demo-ev-' + ivSeq, meet: '#demo-meet', status: 'Completed' });
      if (NO_FEEDBACK[c.candId]) continue;
      var negLast = (c.stage === 'Interview Reject' && i === done - 1) || (c.stage === 'On Hold' && i === 1);
      var rating = clamp(Math.round(c.fit / 21 + jit(c.candId + 'r' + i, 1.6) - (negLast ? 1.6 : 0)), 2, 5);
      var p1 = POS[hash(c.candId + 'p' + i) % POS.length], p2 = POS[hash(c.candId + 'q' + i) % POS.length], n1 = NEG[hash(c.candId + 'n' + i) % NEG.length];
      FEEDBACK.push({ candId: c.candId, when: fmt(new Date(when.getTime() + 3 * 3600000)), interviewer: ivr, stage: rounds[i], rating: String(Math.round(rating)), recommendation: REC_BY(rating),
        strengths: p1.charAt(0).toUpperCase() + p1.slice(1) + (p2 !== p1 ? '; ' + p2 : ''), concerns: n1.charAt(0).toUpperCase() + n1.slice(1),
        feedback: (negLast ? 'Mixed round. ' : rating >= 4 ? 'Strong round. ' : 'Solid round. ') + first(c.name) + ' ' + (rounds[i] === 'Screening' ? 'is motivated by the role and logistics line up (notice ' + (c.notice || '?') + ' days).' : rounds[i] === 'Hiring Manager' ? 'would raise the bar on the team — ' + p1 + '.' : 'showed ' + p1 + '; ' + n1 + '.'),
        source: 'In-app' });
    }
    if (c.stage === 'Interview Scheduled') {
      ivSeq++;
      var ivr2 = r.interviewers[1 % r.interviewers.length];
      INTERVIEWS.push({ id: 'INT-' + ('00' + ivSeq).slice(-3), candId: c.candId, reqId: c.reqId, stage: rounds[1] || 'Technical', interviewers: ivr2.split(' ')[0].toLowerCase() + '.' + ivr2.split(' ')[1].toLowerCase() + '@example.com, arjun.mehta@example.com', when: daysAhead(1 + hash(c.candId) % 3, 11 + hash(c.name) % 5, 0), eventId: 'demo-ev-' + ivSeq, meet: '#demo-meet', status: 'Scheduled' });
    }
  });
  function ivsFor(id) { return INTERVIEWS.filter(function (v) { return v.candId === id; }); }
  function fbFor(id) { return FEEDBACK.filter(function (f) { return f.candId === id; }); }

  /* ------------------------------------------------------------------ scoring (internally consistent) */
  function expFit(r, y) { var sp = r.sp; if (y > sp.exp_max) return Math.max(78, 100 - (y - sp.exp_max) * 3); if (y < sp.exp_min) return Math.max(30, 100 - (sp.exp_min - y) * 12); return 100; }
  function hasKey(text, k) { text = ' ' + low(text).replace(/[^a-z0-9/+#.]+/g, ' ') + ' '; k = low(k).replace(/[^a-z0-9/+#.]+/g, ' '); return text.indexOf(' ' + k + ' ') > -1; }
  function coverage(c, r) { var text = c.title + ', ' + c.skills; return r.must.map(function (m) { return { item: m.label, met: m.keys.some(function (k) { return hasKey(text, k); }) }; }); }
  function covPct(c, r) { var cv = coverage(c, r); return cv.length ? Math.round(cv.filter(function (x) { return x.met; }).length / cv.length * 100) : null; }
  function compBand(c, r) { var n = Number(c.ectc) || 0; if (!n) return ''; if (n > r.salaryMax * 1.05) return 'above budget'; if (n < r.salaryMin * 0.9) return 'below band'; return 'within band'; }
  function rankRow(c, r) {
    var cov = covPct(c, r), ef = Math.round(expFit(r, c.exp));
    var fin = Math.round(c.fit * 0.7 + (cov == null ? c.fit : cov) * 0.15 + ef * 0.15);
    return { candId: c.candId, name: c.name, title: c.title, company: c.company, exp: c.exp, stage: c.stage, reqId: r.id, score: fin, llm: c.fit, coverage: cov, expFit: ef, over: c.exp > r.sp.exp_max + 3, comp: compBand(c, r), reason: c.note, matched: null, pool: c.stage === 'Talent Pool' };
  }
  var RANK_TS = {
    'REQ-101': { when: fmtLong(daysAgo(1, 18, 40)), who: 'Jordan Blake' }, 'REQ-102': { when: fmtLong(daysAgo(2, 16, 5)), who: 'Jordan Blake' },
    'REQ-103': { when: fmtLong(daysAgo(1, 12, 20)), who: 'Nina Castell' }, 'REQ-104': { when: fmtLong(daysAgo(3, 9, 50)), who: 'Jordan Blake' },
    'REQ-105': { when: fmtLong(daysAgo(2, 11, 15)), who: 'Nina Castell' }
  };
  function stackRank(reqId) {
    var r = req(reqId); var list = reqCands(reqId); if (!r || !list.length) return { error: 'No candidates on this requisition.' };
    var ranked = list.map(function (c) { return rankRow(c, r); }).sort(function (a, b) { return b.score - a.score; });
    return { ranked: ranked, count: ranked.length, total: ranked.length, hasMust: true, hasCalibration: !r.noCalibration, engine: 'listwise', rankedAt: RANK_TS[reqId] || null,
      sp: { exp_min: r.sp.exp_min, exp_ideal: r.sp.exp_ideal, exp_max: r.sp.exp_max, summary: r.sp.summary, market_note: r.sp.market_note, core_skills: r.sp.core_skills, typical_titles: [] } };
  }
  var LOW_CATS = { 'Publications, Patents & Research': -1.6, 'Awards & Recognition': -0.9, 'Sales & Commercial Performance': -1.2, 'Entrepreneurial & Innovation Signals': -0.6, 'Professional Community & Influence': -0.7, 'Non-Tech Functional Depth': -0.5 };
  var RUBRIC_CFG = {}; REQS.forEach(function (r) { RUBRIC_CFG[r.id] = clone(r.rubric); });
  function rubricFor(c, regen) {
    var r = req(c.reqId) || REQ['REQ-101']; var cfg = RUBRIC_CFG[r.id] || r.rubric; var scores = {};
    var base = 0.6 + c.fit / 100 * 4.4;
    ENGINE.categories.forEach(function (cat) {
      var adj = LOW_CATS[cat] || 0;
      if (cat === 'Sales & Commercial Performance' && r.id === 'REQ-105') adj = 0;
      if (cat === 'Leadership & People Management') adj = (r.id === 'REQ-104' || r.id === 'REQ-105') ? 0 : -0.4;
      if (cat === 'Compensation & Level Signals') adj = compBand(c, r) === 'above budget' ? -1.5 : 0.2;
      if (cat === 'Seniority & Scope Indicators' && c.exp > r.sp.exp_max) adj = 0.3;
      if (cat === 'JD / Role-Fit Alignment') adj = ((covPct(c, r) || 0) - 60) / 40;
      var s = base + adj + jit(c.candId + cat + (regen ? 'r' : ''), 1.4);
      scores[cat] = clamp(Math.round(s * 2) / 2, 0, 5);
    });
    var gate = !/reject/i.test(c.stage) || c.fit >= 50;
    var res = rubricScore(cfg.role, cfg.company, cfg.threshold, gate, scores);
    return { composite: res.composite, verdict: res.verdict, minRequired: res.minRequired, effectiveWeights: res.effectiveWeights, topCategories: res.topCategories, scores: scores, gate: gate, role: cfg.role, company: cfg.company, threshold: cfg.threshold, summary: c.note };
  }
  var FIT_KEYS = ['skills', 'domain', 'problem_solving', 'pedigree', 'impact', 'certs', 'stability', 'logistics'];
  var FIT_LABELS = { skills: 'Skills / tech match', domain: 'Relevant domain exp', problem_solving: 'Problem-solving / design', pedigree: 'Company / education pedigree', impact: 'Impact / progression', certs: 'Certifications / regulatory', stability: 'Stability / tenure', logistics: 'Logistics (notice/CTC/relocate)' };
  var FIT_PRESETS = {
    'Services (IT/Consulting)': { skills: 30, domain: 20, problem_solving: 5, pedigree: 10, impact: 5, certs: 10, stability: 5, logistics: 15 },
    'Product company': { skills: 25, domain: 10, problem_solving: 20, pedigree: 20, impact: 15, certs: 0, stability: 5, logistics: 5 },
    'Ecommerce': { skills: 20, domain: 15, problem_solving: 15, pedigree: 10, impact: 20, certs: 5, stability: 5, logistics: 10 },
    'AI / ML': { skills: 25, domain: 15, problem_solving: 15, pedigree: 15, impact: 10, certs: 5, stability: 5, logistics: 10 },
    'Fintech': { skills: 20, domain: 25, problem_solving: 15, pedigree: 15, impact: 5, certs: 10, stability: 5, logistics: 5 },
    'Media / Creative': { skills: 20, domain: 15, problem_solving: 10, pedigree: 10, impact: 20, certs: 5, stability: 5, logistics: 15 },
    'Industrial / Manufacturing': { skills: 20, domain: 25, problem_solving: 10, pedigree: 10, impact: 5, certs: 15, stability: 5, logistics: 10 },
    'Pharma / Healthcare': { skills: 15, domain: 25, problem_solving: 5, pedigree: 15, impact: 5, certs: 20, stability: 5, logistics: 10 }
  };
  var FIT_CFG = {}; REQS.forEach(function (r) { FIT_CFG[r.id] = { archetype: r.fitArch, weights: clone(FIT_PRESETS[r.fitArch]) }; });
  function fitFor(c) {
    var r = req(c.reqId) || REQ['REQ-101'], cfg = FIT_CFG[r.id], W = cfg.weights, cov = coverage(c, r), cp = covPct(c, r) || 0;
    var comp = {
      skills: Math.round(c.fit * 0.6 + cp * 0.4), domain: Math.round(c.fit + jit(c.candId + 'd', 18)), problem_solving: Math.round(c.fit + jit(c.candId + 'ps', 14)),
      pedigree: Math.round(68 + jit(c.candId + 'pe', 30)), impact: Math.round(c.fit + jit(c.candId + 'im', 16)), certs: Math.round(45 + jit(c.candId + 'ce', 30)),
      stability: Math.round(c.exp >= 4 ? 78 + jit(c.candId + 'st', 20) : 62), logistics: Math.round((Number(c.notice) > 60 ? 55 : 82) - (compBand(c, r) === 'above budget' ? 25 : 0))
    };
    var totW = 0, acc = 0, rows = [];
    FIT_KEYS.forEach(function (k) { var w = Number(W[k] || 0), s = clamp(comp[k], 0, 100); totW += w; acc += s * w; rows.push({ key: k, label: FIT_LABELS[k], score: s, weight: w, contribution: 0 }); });
    var weighted = totW ? Math.round(acc / totW) : 0; rows.forEach(function (x) { x.contribution = totW ? Math.round(x.score * x.weight / totW) : 0; });
    var rel = Math.round(comp.skills * 0.6 + comp.domain * 0.4), sem = clamp(Math.round(c.fit - 6 + jit(c.candId + 'sem', 10)), 5, 97);
    var gated = sem < 25, total = gated ? Math.round(weighted * sem / 25) : weighted;
    var met = cov.filter(function (x) { return x.met; }).map(function (x) { return x.item; }), miss = cov.filter(function (x) { return !x.met; }).map(function (x) { return x.item; });
    var strengths = met.slice(0, 3).map(function (m) { return '✓ ' + m; }); strengths.push(c.note.split(';')[0].replace(/\.$/, ''));
    var gaps = miss.map(function (m) { return 'No clear evidence: ' + m; });
    if (compBand(c, r) === 'above budget') gaps.push('Expected CTC is above the requisition budget');
    if (c.exp > r.sp.exp_max) gaps.push('Experience (' + c.exp + ' yrs) is above the target band — check scope expectations');
    if (Number(c.notice) >= 90) gaps.push('90-day notice period');
    var focus = (miss.length ? miss.map(function (m) { return 'Probe: ' + m; }) : ['Go deep on the largest system / project they owned end-to-end']).concat(['Ask for a specific, measurable outcome from the last 12 months']);
    return { total: total, weighted: weighted, relevance: rel, semantic: sem, gated: gated, recommendation: total >= 70 ? 'Strong fit' : total >= 45 ? 'Possible fit' : 'Weak fit', archetype: cfg.archetype, reqId: r.id, components: rows, coverage: cov, strengths: strengths, gaps: gaps.length ? gaps : ['No material gaps against the must-haves'], focus: focus.slice(0, 3), summary: c.note, hasCalibration: !r.noCalibration };
  }

  /* ------------------------------------------------------------------ calibration, settings, misc state */
  var CAL = {}; REQS.forEach(function (r) {
    CAL[r.id] = r.noCalibration ? { reqId: r.id, files: [], voiceUrl: '', transcript: '', brief: null, notes: '' } :
      { reqId: r.id, files: [{ name: r.title + ' — take-home brief.pdf', url: '#demo-file', kind: 'take-home' }, { name: 'Interview scorecard.pdf', url: '#demo-file', kind: 'scorecard' }], voiceUrl: '#demo-voice',
        transcript: r.hm + ' (voice note): the must-haves are ' + r.must.map(function (m) { return m.label.toLowerCase(); }).join(', ') + '. Nice to have: ' + (r.nice.join(', ') || 'n/a') + '. Please avoid ' + (r.flags.join(', ').toLowerCase() || 'n/a') + '.',
        brief: { must_haves: r.must.map(function (m) { return m.label; }), nice_to_haves: r.nice, red_flags: r.flags, summary: r.sp.summary }, notes: 'Comp flexible up to ' + (r.salaryMax / 100000) + 'L for an exceptional candidate. HM prefers interviews Tue–Thu.' };
  });
  var STATE = { bias: false, weightsCustom: false, plans: {}, tuning: {} };
  REQS.forEach(function (r) { STATE.plans[r.id] = r.plan; });
  var ORG = { company: 'AgentATS', recruiterName: RECRUITER.name, recruiterTitle: RECRUITER.title,
    logoUrl: 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 84 84"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6C4CF1"/><stop offset="1" stop-color="#3A2599"/></linearGradient></defs><rect width="84" height="84" rx="20" fill="url(#g)"/><text x="42" y="54" text-anchor="middle" font-family="Space Grotesk,Segoe UI,Arial,sans-serif" font-size="32" font-weight="700" fill="#fff" letter-spacing="-1">AA</text><circle cx="66" cy="20" r="6" fill="#13A463"/></svg>'),
    type: 'B2B SaaS — mid-cap product company', hires: 'Backend engineers, product designers, data analysts, engineering managers, customer success',
    bar: 'Ships independently, strong fundamentals, owns outcomes end-to-end', workStart: 9, workEnd: 18, slotMin: 60, ack: true, chatWebhook: '', alertEmail: 'talent@example.com', reportLink: '',
    stageSla: { screening: 5, interview: 4, debrief: 3, offer: 3, other: 10 }, rerankUrl: '', rerankToken: '', patentKey: '', defaultCompany: 'Mid-cap SaaS' };
  var SLA = ORG.stageSla;
  function slaFor(stage) { var s = low(stage); if (s.indexOf('screen') > -1) return SLA.screening; if (s.indexOf('debrief') > -1) return SLA.debrief; if (s.indexOf('offer') > -1) return SLA.offer; if (s.indexOf('interview') > -1) return SLA.interview; return SLA.other; }
  function isTerminal(s) { s = low(s); return s.indexOf('reject') > -1 || s.indexOf('hire') > -1 || s.indexOf('onboard') > -1 || s.indexOf('declin') > -1 || s.indexOf('talent pool') > -1; }

  /* ------------------------------------------------------------------ screens */
  function pipelineItem(c) {
    var r = req(c.reqId), miss = []; if (!c.email) miss.push('email'); if (!c.ctc) miss.push('CTC'); if (c.notice === '') miss.push('notice'); if (!c.gender) miss.push('gender');
    var rr = r ? rankRow(c, r) : null;
    return { candId: c.candId, name: c.name, email: c.email, stage: c.stage, score: '', company: c.company, exp: c.exp, skills: c.skills.split(', ').slice(0, 4).join(', '), ctc: c.ctc, notice: c.notice, location: c.location, hasCv: c.hasCv,
      match: (rr && RANK_TS[c.reqId]) ? rr.score : null, over: !!(rr && rr.over), comp: rr ? rr.comp : '', missing: miss };
  }
  var STAGE_ORDER = ['Offered', 'Selected', 'Debrief', 'Interview', 'Interview Scheduled', 'Shortlist', 'Screened', 'New', 'On Hold', 'Offer Declined', 'Onboarded', 'Interview Reject', 'Debrief Reject', 'CV Screen Reject', 'Rejected'];
  function getReqPipeline(reqId) {
    return reqCands(reqId).map(pipelineItem).sort(function (a, b) { var d = STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage); return d || ((b.match || 0) - (a.match || 0)); });
  }
  function workflow(reqId) {
    var r = req(reqId), pl = reqCands(reqId), cal = CAL[reqId] || {}, b = cal.brief || {};
    var shortlisted = pl.some(function (c) { var s = low(c.stage); return s.indexOf('shortlist') > -1 || s.indexOf('interview') > -1 || s.indexOf('debrief') > -1; });
    return [
      { n: 1, label: 'Calibrate the role (must-haves)', done: !!(b.must_haves && b.must_haves.length), action: 'cal' },
      { n: 2, label: 'Set interview plan', done: !!(STATE.plans[reqId] && STATE.plans[reqId].length > 2), action: 'plan' },
      { n: 3, label: 'Add / source candidates', done: pl.length > 0, action: 'add' },
      { n: 4, label: 'Screen & shortlist (fit score)', done: shortlisted, action: '' },
      { n: 5, label: 'Schedule interviews', done: INTERVIEWS.some(function (v) { return v.reqId === reqId; }), action: '' },
      { n: 6, label: 'Collect feedback & debrief', done: pl.some(function (c) { return fbFor(c.candId).length > 0; }), action: '' },
      { n: 7, label: 'Decision / offer', done: pl.some(function (c) { var s = low(c.stage); return s.indexOf('offer') > -1 || s.indexOf('onboard') > -1; }), action: '' }
    ];
  }
  function reqSummary(id) { var r = req(id); if (!r) return null; return { id: r.id, title: r.title, department: r.department, lob: r.lob, location: r.location, employment: r.employment, level: r.level, hm: r.hm, recruiter: r.recruiter, openings: r.openings, priority: r.priority, status: r.status, jdLink: '#demo-jd', notes: r.notes, hmEmail: r.hmEmail }; }
  function getToday(scope) {
    var hmReqs = {}; if (scope) REQS.forEach(function (r) { if (low(r.hmEmail) === low(scope)) hmReqs[r.id] = 1; });
    function inScope(id) { return !scope || hmReqs[id]; }
    var out = { newApps: [], awaitingFb: [], debriefs: [], stuck: [], offers: [], reqsNeed: [] };
    CANDS.forEach(function (c) {
      if (!inScope(c.reqId)) return; var s = low(c.stage), item = { candId: c.candId, name: c.name, stage: c.stage, reqId: c.reqId };
      var recvDays = (NOW - c.received) / 86400000;
      if (s === 'new' && recvDays < 7) out.newApps.push(item);
      if (ivsFor(c.candId).length && !fbFor(c.candId).length && !isTerminal(s)) out.awaitingFb.push(item);
      if (s.indexOf('debrief') > -1 && s.indexOf('reject') < 0) out.debriefs.push(item);
      if (s.indexOf('offer') > -1 && s.indexOf('declin') < 0 && s.indexOf('onboard') < 0) out.offers.push(item);
      if (!isTerminal(s)) { var sla = slaFor(c.stage); if (c.inStage >= sla) out.stuck.push({ candId: c.candId, name: c.name, stage: c.stage, reqId: c.reqId, days: c.inStage, sla: sla }); }
    });
    REQS.forEach(function (r) { if (r.status !== 'Open' || !inScope(r.id)) return; var needs = []; if (!(CAL[r.id].brief)) needs.push('calibration'); if (!reqCands(r.id).length) needs.push('candidates'); if (needs.length) out.reqsNeed.push({ reqId: r.id, title: r.title, needs: needs }); });
    out.newApps.sort(function (a, b) { return CAND[b.candId].received - CAND[a.candId].received; });
    out.stuck.sort(function (a, b) { return b.days - a.days; });
    return out;
  }
  function board(scope) { return REQS.filter(function (r) { return !scope || low(r.hmEmail) === low(scope); }).map(function (r) { return { id: r.id, title: r.title, lob: r.lob, hm: r.hm, openings: r.openings, status: r.status, count: reqCands(r.id).length }; }); }
  function canon(s) { s = low(s); return { 'advanced (debrief)': 'selected', 'rejected (debrief)': 'debrief reject', 'on hold': 'debrief', 'hired': 'onboarded' }[s] || s; }
  var STAGE_METRICS = function () {
    var hireDays = CANDS.filter(function (c) { return /offer|onboard/i.test(c.stage); }).map(function (c) { return Math.round((NOW - c.received) / 86400000) - c.inStage + (c.stage === 'Onboarded' ? -14 : 0); });
    var avg = hireDays.length ? Math.round(hireDays.reduce(function (a, b) { return a + b; }, 0) / hireDays.length) : null;
    return { avgTimeToHire: avg, hiredCount: hireDays.length, perStage: [{ stage: 'Interview', avgDays: 6 }, { stage: 'Interview Scheduled', avgDays: 5 }, { stage: 'Shortlist', avgDays: 4 }, { stage: 'Debrief', avgDays: 3 }, { stage: 'Screened', avgDays: 3 }, { stage: 'Offered', avgDays: 3 }, { stage: 'New', avgDays: 2 }] };
  };
  function analytics(hm) {
    var total = 0, bySource = {}, srcHire = {}, byReq = {}, byHM = {}, reached = { applied: 0, screened: 0, interviewed: 0, offered: 0, hired: 0 }, rejects = { cv: 0, interview: 0, debrief: 0, other: 0 }, offered = 0, declined = 0, onboarded = 0;
    var SCR = ['screened', 'shortlist', 'interview', 'interview scheduled', 'interview reject', 'debrief', 'debrief reject', 'selected', 'offered', 'offer declined', 'onboarded'];
    var IVW = ['interview reject', 'debrief', 'debrief reject', 'selected', 'offered', 'offer declined', 'onboarded'], OFR = ['offered', 'offer declined', 'onboarded'];
    CANDS.forEach(function (c) {
      var r = req(c.reqId), chm = r ? r.hm : ''; if (hm && chm !== hm) return; total++;
      bySource[c.source] = (bySource[c.source] || 0) + 1; var sl = canon(c.stage); reached.applied++;
      if (SCR.indexOf(sl) > -1) reached.screened++; if (IVW.indexOf(sl) > -1 || fbFor(c.candId).length) reached.interviewed++; if (OFR.indexOf(sl) > -1) reached.offered++; if (sl === 'onboarded') reached.hired++;
      if (sl === 'cv screen reject') rejects.cv++; else if (sl === 'interview reject') rejects.interview++; else if (sl === 'debrief reject') rejects.debrief++; else if (sl === 'rejected') rejects.other++;
      if (sl === 'offered') offered++; if (sl === 'offer declined') declined++; if (sl === 'onboarded') onboarded++;
      if (['selected', 'offered', 'onboarded'].indexOf(sl) > -1) srcHire[c.source] = (srcHire[c.source] || 0) + 1;
      if (r) { var k = r.id + ' — ' + r.title; byReq[k] = (byReq[k] || 0) + 1; byHM[chm] = (byHM[chm] || 0) + 1; }
    });
    var decided = onboarded + declined;
    return { total: total, reached: reached, bySource: bySource, srcHire: srcHire, rejects: rejects, offered: offered, declined: declined, onboarded: onboarded, byReq: byReq, byHM: byHM, metrics: STAGE_METRICS(),
      allHMs: REQS.map(function (r) { return r.hm; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(), scopedHM: hm || '', offerAcceptRate: decided ? Math.round(onboarded / decided * 100) : null };
  }
  function roundMetrics(ids) {
    if (!Array.isArray(ids)) ids = ids ? [ids] : []; var all = !ids.length, set = {}; ids.forEach(function (x) { set[x] = 1; });
    var reqs = [], order = [], seen = {}, sch = {}, fbc = {};
    REQS.forEach(function (r) { if (!all && !set[r.id]) return; reqs.push({ id: r.id, title: r.title }); plannedRounds({ plan: STATE.plans[r.id] }).forEach(function (n) { if (!seen[low(n)]) { seen[low(n)] = 1; order.push(n); } }); });
    var schSeen = {}, fbSeen = {};
    INTERVIEWS.forEach(function (v) { if (!all && !set[v.reqId]) return; var k = low(v.stage); if (!seen[k]) { seen[k] = 1; order.push(v.stage); } if (!schSeen[k + v.candId]) { schSeen[k + v.candId] = 1; sch[k] = (sch[k] || 0) + 1; } });
    FEEDBACK.forEach(function (f) { var c = CAND[f.candId]; if (!c || (!all && !set[c.reqId])) return; var k = low(f.stage); if (!fbSeen[k + f.candId]) { fbSeen[k + f.candId] = 1; fbc[k] = (fbc[k] || 0) + 1; } });
    return { reqs: reqs, rounds: order.map(function (n) { return { name: n, scheduled: sch[low(n)] || 0, interviewed: fbc[low(n)] || 0 }; }) };
  }
  function candidateFull(id) {
    var c = CAND[id]; if (!c) return { error: 'Candidate not found.' }; var r = req(c.reqId);
    var F = { 'Date Received': fmt(c.received), 'Candidate Name': c.name, 'Email': c.email, 'Source': c.source, 'Stage': c.stage, 'Req ID': c.reqId, 'Phone': c.phone, 'Current Location': c.location,
      'Outstation': c.location.indexOf('Remote') > -1 ? 'No' : (hash(id) % 2 ? 'Yes' : 'No'), 'Willing to Relocate': c.relocate, 'Work Mode Preference': c.workmode, 'Current Company': c.company, 'Current Title': c.title,
      'Total Experience (yrs)': String(c.exp), 'Skills': c.skills, 'Highest Qualification': c.qual, 'Notice Period': c.notice === '' ? '' : String(c.notice), 'Current CTC': c.ctc ? 'INR ' + c.ctc : '', 'Expected CTC': 'INR ' + c.ectc,
      'Offer in Hand': c.offerInHand, 'Work Authorization': 'Authorized to work in India', 'Reason for Change': c.reason, 'HR Remarks': c.remarks, 'Gender': c.gender, 'Candidate ID': c.candId,
      'First Name': c.firstName, 'Middle Name': c.middleName, 'Last Name': c.lastName, 'Highlights': c.highlights || '' };
    Object.keys(F).forEach(function (k) { if (F[k] === '' || F[k] == null) delete F[k]; });
    var audit = [{ when: fmt(daysAgo(c.inStage, 11, 0)), who: c.reqId === 'REQ-103' || c.reqId === 'REQ-105' ? 'Nina Castell' : 'Jordan Blake', summary: 'Stage → "' + c.stage + '"' }];
    if (c.inStage + 3 < (NOW - c.received) / 86400000) audit.push({ when: fmt(daysAgo(c.inStage + 3, 15, 20)), who: 'Jordan Blake', summary: 'Expected CTC: "" → "INR ' + c.ectc + '" · Notice Period: "" → "' + (c.notice || '') + '"' });
    audit.push({ when: fmt(c.received), who: 'AgentATS (CV parser)', summary: 'Candidate created from CV · source ' + c.source });
    return { name: c.name, email: c.email, resume: c.hasCv ? '#demo-cv' : '', candId: c.candId, reqId: c.reqId, reqTitle: r ? r.title : '', fields: F, feedback: [],
      interviews: ivsFor(id).map(function (v) { return { id: v.id, stage: v.stage, interviewers: v.interviewers, when: fmt(v.when), eventId: v.eventId, meet: v.meet, status: v.status }; }),
      audit: audit, appFeedback: fbFor(id).slice().reverse() };
  }
  function debrief(id) {
    var c = CAND[id], fbs = fbFor(id); if (!c) return { error: 'Candidate not found.' }; if (!fbs.length) return { error: 'No interview feedback yet to debrief.' };
    var nums = fbs.map(function (f) { return parseFloat(f.rating); }), avg = (nums.reduce(function (a, b) { return a + b; }, 0) / nums.length);
    var rec = avg >= 4.2 ? 'Strong Hire' : avg >= 3.6 ? 'Hire' : avg >= 3 ? 'Lean Hire — needs one more signal' : 'No Hire';
    var st = [], seen = {}; fbs.forEach(function (f) { f.strengths.split('; ').forEach(function (s) { var k = low(s); if (s && !seen[k]) { seen[k] = 1; st.push(s.charAt(0).toUpperCase() + s.slice(1)); } }); });
    var co = []; fbs.forEach(function (f) { if (co.indexOf(f.concerns) < 0) co.push(f.concerns); });
    return { name: c.name, count: fbs.length, avgRating: avg.toFixed(1), panel: fbs, overall_recommendation: rec, confidence: fbs.length >= 3 ? 'High' : 'Medium',
      key_strengths: st.slice(0, 4), key_concerns: co.slice(0, 3), rationale: first(c.name) + ' was assessed by ' + fbs.length + ' interviewer' + (fbs.length > 1 ? 's' : '') + ' with an average rating of ' + avg.toFixed(1) + '/5. ' + c.note + ' The panel is ' + (avg >= 3.6 ? 'broadly aligned; concerns raised are coachable rather than disqualifying.' : 'split, so a decision should weigh the specific concerns against the role\'s must-haves.'),
      suggested_decision: avg >= 3.6 ? 'Advance to offer' : avg >= 3 ? 'Hold — run a focused follow-up round' : 'Reject with kind feedback' };
  }
  function search(q) {
    var toks = low(q).split(/\s+/).filter(Boolean);
    function all(t) { t = low(t); return toks.every(function (k) { return t.indexOf(k) > -1 || t.indexOf(k.replace(/(ed|es|s)$/, '')) > -1; }); }
    var reqs = REQS.filter(function (r) { return all([r.id, r.title, r.department, r.lob, r.location, r.level, r.hm, r.recruiter, r.status, r.notes].join(' ')); }).map(function (r) { return { id: r.id, title: r.title, dept: r.department, lob: r.lob, location: r.location, hm: r.hm, status: r.status }; });
    var cands = CANDS.filter(function (c) { return all([c.name, c.email, c.phone, c.location, c.company, c.title, c.skills, c.stage, c.reqId, c.candId].join(' ')); }).map(function (c) { return { candId: c.candId, name: c.name, email: c.email, phone: c.phone, location: c.location, company: c.company, stage: c.stage, reqId: c.reqId, score: '', hasCv: c.hasCv }; });
    return { reqs: reqs, candidates: cands, count: reqs.length + cands.length };
  }
  function suggest(q) {
    q = low(q).trim(); if (q.length < 2) return []; var out = [];
    REQS.forEach(function (r) { if (low([r.id, r.title, r.lob, r.hm].join(' ')).indexOf(q) > -1) out.push({ type: 'req', id: r.id, label: r.id + ' — ' + r.title, sub: 'Requisition · HM ' + r.hm }); });
    CANDS.forEach(function (c) { if (low([c.name, c.email, c.phone, c.location, c.company, c.title, c.skills].join(' ')).indexOf(q) > -1) out.push({ type: 'cand', id: c.candId, reqId: c.reqId, label: c.name, sub: 'Candidate · ' + c.stage + ' · ' + c.company }); });
    return out.slice(0, 10);
  }
  function insights() {
    var byStage = {}, active = 0, aging = [];
    CANDS.forEach(function (c) { byStage[c.stage] = (byStage[c.stage] || 0) + 1; if (!isTerminal(c.stage)) { active++; if (c.inStage >= 10) aging.push({ candId: c.candId, name: c.name, stage: c.stage, days: c.inStage, reqId: c.reqId }); } });
    aging.sort(function (a, b) { return b.days - a.days; });
    return { active: active, byStage: byStage, aging: aging, metrics: STAGE_METRICS() };
  }
  function rediscover(reqId) {
    var r = req(reqId); if (!r) return { error: 'Requisition not found.' };
    var terms = r.sp.core_skills.map(low).concat(r.title.toLowerCase().split(' '));
    var pool = CANDS.filter(function (c) { return c.reqId !== reqId && (c.stage === 'Talent Pool' || /reject|declin|hold/i.test(c.stage)); });
    var scored = pool.map(function (c) {
      var t = low(c.title + ' ' + c.skills), matched = r.sp.core_skills.filter(function (s) { return hasKey(t, s); });
      if (!matched.length) return null;
      var row = rankRow(c, r); var bonus = matched.length / r.sp.core_skills.length;
      row.score = Math.round(clamp(row.score * (0.45 + bonus * 0.75), 10, 95)); row.matched = matched; row.pool = c.stage === 'Talent Pool';
      row.reason = (row.pool ? 'Talent Pool · ' : 'Previously in ' + c.reqId + ' (' + c.stage + ') · ') + 'matches ' + matched.length + ' of ' + r.sp.core_skills.length + ' core skills. ' + c.note;
      return row;
    }).filter(Boolean).sort(function (a, b) { return b.score - a.score; });
    return { terms: r.sp.core_skills.slice(0, 8), candidates: scored, ranked: scored, sp: { exp_min: r.sp.exp_min, exp_ideal: r.sp.exp_ideal, exp_max: r.sp.exp_max, market_note: r.sp.market_note, core_skills: r.sp.core_skills }, reqTitle: r.title };
  }
  var IMPLIED = { 'go': ['Concurrency patterns', 'Profiling (pprof)'], 'kafka': ['Exactly-once semantics', 'Consumer-group tuning'], 'postgresql': ['Query optimisation', 'Schema migrations'], 'kubernetes': ['Helm', 'Container security'], 'aws': ['IAM', 'CloudWatch'], 'java': ['JVM tuning', 'Spring ecosystem'], 'figma': ['Auto-layout systems', 'Design tokens'], 'design systems': ['Component governance', 'Documentation'], 'user research': ['Interview synthesis', 'Journey mapping'], 'sql': ['Window functions', 'Data modelling'], 'python': ['pandas', 'Jupyter'], 'dbt': ['Data testing', 'Lineage'], 'a/b testing': ['Power analysis', 'Guardrail metrics'], 'people leadership': ['Performance reviews', 'Career frameworks'], 'hiring': ['Structured interviewing'], 'renewals': ['Forecasting', 'Commercial negotiation'], 'onboarding': ['Playbook design'], 'team leadership': ['Coaching', '1:1s'], 'terraform': ['Infrastructure as code reviews'] };
  var ADJ = { 'go': ['Rust'], 'kafka': ['Pulsar', 'Kinesis'], 'java': ['Kotlin'], 'figma': ['Framer'], 'sql': ['dbt'], 'python': ['Machine learning basics'], 'people leadership': ['Org design'], 'renewals': ['Account expansion strategy'], 'kubernetes': ['Service mesh'], 'tableau': ['Looker'], 'looker': ['Tableau'], 'b2b saas': ['Product-led growth'] };
  function skillsFor(c) {
    var ex = c.skills.split(', '), im = [], ad = [];
    ex.forEach(function (s) { (IMPLIED[low(s)] || []).forEach(function (x) { if (im.indexOf(x) < 0) im.push(x); }); (ADJ[low(s)] || []).forEach(function (x) { if (ad.indexOf(x) < 0 && ex.indexOf(x) < 0) ad.push(x); }); });
    if (!im.length) im = ['Stakeholder communication', 'Documentation']; if (!ad.length) ad = ['Adjacent tooling in the same ecosystem'];
    var sen = c.exp >= 12 ? 'Principal / Director' : c.exp >= 9 ? 'Lead / Staff' : c.exp >= 5 ? 'Senior' : c.exp >= 3 ? 'Mid' : 'Junior';
    return { explicit: ex, implied: im, adjacent: ad, seniority: sen };
  }
  function graph(c) {
    var r = req(c.reqId); if (!r) return { error: 'This candidate is not tagged to a requisition yet — tag them to see a graph match.' };
    var sk = skillsFor(c), cov = coverage(c, r);
    var rows = cov.map(function (x, i) { if (x.met) return { req: x.item, via: 'explicit' }; var adj = c.fit >= 70 && i % 2 === 0; return { req: x.item, via: adj ? (i % 4 === 0 ? 'implied' : 'adjacent') : 'none' }; });
    r.nice.forEach(function (n, i) { rows.push({ req: n, via: c.fit >= 80 ? (i % 2 ? 'implied' : 'adjacent') : 'none' }); });
    var covd = rows.filter(function (x) { return x.via !== 'none'; }).length;
    return { pct: Math.round(covd / rows.length * 100), covered: covd, count: rows.length, seniority: sk.seniority, coverage: rows, graph: { explicit: sk.explicit, implied: sk.implied, adjacent: sk.adjacent } };
  }
  function aiBrief(id) {
    var c = CAND[id]; if (!c) return 'Candidate not found.'; var r = req(c.reqId), fb = fbFor(id), ff = r ? fitFor(c) : null;
    var lines = ['📌 Snapshot: ' + c.title + ' at ' + c.company + ' · ' + c.exp + ' yrs · ' + c.location + ' · notice ' + (c.notice || '—') + ' days · expected INR ' + (c.ectc / 100000).toFixed(1) + 'L' + (r ? ' (' + compBand(c, r) + ')' : '') + '.'];
    if (r) lines.push('🎯 Fit for ' + r.title + ': ' + (ff.total >= 70 ? 'strong' : ff.total >= 45 ? 'possible' : 'weak') + ' (' + ff.total + '/100). ' + c.note);
    else lines.push('🌱 In the Talent Pool. ' + c.note);
    if (fb.length) { var avg = fb.reduce(function (a, f) { return a + Number(f.rating); }, 0) / fb.length; lines.push('🗣 Interviews: ' + fb.length + ' round' + (fb.length > 1 ? 's' : '') + ', average ' + avg.toFixed(1) + '/5. Panel highlights — ' + fb[0].strengths.toLowerCase() + '. Watch-out — ' + fb[fb.length - 1].concerns.toLowerCase() + '.'); }
    else lines.push('🗣 Interviews: none completed yet.');
    lines.push('✅ Recommendation: ' + (ff && ff.total >= 75 ? 'move forward quickly — this profile will have other offers.' : ff && ff.total >= 55 ? 'worth a focused next round on the gaps above.' : 'keep warm for a better-matched role.'));
    return lines.join('\n');
  }
  function reqBrief(id) {
    var r = req(id); if (!r) return 'Requisition not found.'; var sr = stackRank(id);
    if (sr.error) return 'Hiring brief — ' + r.title + ' (' + r.id + ')\n\nNo candidates yet. ' + r.sp.market_note + '\n\nNext step: calibrate the must-haves with ' + r.hm + ' and run ♻️ Rediscover talent — there is a strong match in the Talent Pool.';
    var top = sr.ranked.slice(0, 3);
    return 'Hiring brief — ' + r.title + ' (' + r.id + '), hiring manager ' + r.hm + '.\n\n' + r.sp.summary + ' ' + r.sp.market_note + '\n\nThe pipeline has ' + sr.count + ' candidates. Top of the shortlist:\n' + top.map(function (t, i) { return (i + 1) + '. ' + t.name + ' — ' + t.score + '/100, ' + t.stage + '. ' + t.reason; }).join('\n') + '\n\nRecommendation: prioritise ' + first(top[0].name) + ' and keep ' + first(top[1].name) + ' warm as a strong second option.';
  }

  /* ------------------------------------------------------------------ chat (processMessage) */
  var ROLE_WORDS = [['REQ-101', ['backend', 'back-end', 'go ', 'golang', 'kafka', 'server']], ['REQ-102', ['design', 'ux', 'figma']], ['REQ-103', ['data analyst', 'analyst', 'analytics', 'sql']], ['REQ-104', ['manager', ' em ', 'engineering manager', 'leadership']], ['REQ-105', ['customer success', ' cs ', 'csm', 'renewal']], ['REQ-106', ['sre', 'reliability', 'devops']]];
  function detectReq(t) { t = ' ' + t + ' '; var m = t.match(/req-?\s?(\d{3})/i); if (m && REQ['REQ-' + m[1]]) return 'REQ-' + m[1]; for (var i = 0; i < ROLE_WORDS.length; i++) if (ROLE_WORDS[i][1].some(function (w) { return t.indexOf(w) > -1; })) return ROLE_WORDS[i][0]; return ''; }
  function findCand(t) { var best = null; CANDS.forEach(function (c) { var n = low(c.name); if (t.indexOf(n) > -1 || t.indexOf(low(c.firstName) + ' ') > -1 || t.slice(-low(c.firstName).length - 1).indexOf(low(c.firstName)) > -1) { if (!best || n.length > low(best.name).length) best = c; } }); return best; }
  function processMessage(msg) {
    var t = low(msg).replace(/[?!.]+$/, '').trim(), rid = detectReq(t), c = findCand(t);
    if (/^(help|what can you do|\?)/.test(t)) return HELP;
    if (/^(shortlist|reject|move|advance|hire|create|add|schedule|tag|update|log|note for|email|send)\b/.test(t)) return '🔒 Live demo: commands that change data (“' + msg + '”) are read-only here — in your own AgentATS this would update the tracker, calendar and audit log.\n\nTry asking a question instead, e.g. “who are my strongest backend candidates?”';
    if (/compare/.test(t)) { var two = CANDS.filter(function (x) { return t.indexOf(low(x.firstName)) > -1; }).slice(0, 2); if (two.length === 2) return two.map(function (x) { var rr = req(x.reqId); var s = rr ? rankRow(x, rr) : null; return '• ' + x.name + ' — ' + x.title + ' @ ' + x.company + ', ' + x.exp + 'y · ' + x.stage + (s ? ' · fit ' + s.score : '') + ' · expects INR ' + (x.ectc / 100000).toFixed(1) + 'L · notice ' + (x.notice || '—') + 'd\n  ' + x.note; }).join('\n') + '\n\n➡️ ' + (two[0].fit >= two[1].fit ? two[0].name : two[1].name) + ' is the stronger match on the must-haves.'; }
    if (c && /(tell me|about|story|profile|brief|how did|who is)/.test(t)) return '📇 ' + c.name + ' (' + c.candId + ')' + (c.reqId ? ' — ' + c.reqId + ' ' + req(c.reqId).title : '') + '\n\n' + aiBrief(c.candId);
    if (/(strong|best|top|rank|who should|shortlist for|fit for|great)/.test(t)) {
      var ids = rid ? [rid] : ['REQ-101', 'REQ-104', 'REQ-102'];
      return ids.map(function (id) {
        var sr = stackRank(id), r = req(id); if (sr.error) return '📭 ' + r.id + ' · ' + r.title + ': no candidates yet — the Talent Pool has a close match (try ♻️ Rediscover talent).';
        var act = sr.ranked.filter(function (x) { return !/reject|declin/i.test(x.stage); }).slice(0, rid ? 5 : 3);
        return '🏆 Strongest candidates for ' + r.id + ' · ' + r.title + ' (AI fit + must-have coverage + experience fit):\n' + act.map(function (x, i) { return (i + 1) + '. ' + x.name + ' — ' + x.score + '/100 · ' + x.stage + ' · ' + x.title + ' @ ' + x.company + ', ' + x.exp + 'y' + (x.comp === 'above budget' ? ' · 💰 above budget' : '') + (x.over ? ' · ⚠ over-qualified' : '') + '\n   ' + x.reason; }).join('\n');
      }).join('\n\n') + '\n\nOpen 📋 Requisitions → a role → 📊 Stack rank for the full list and the 37-category rubric breakdown.';
    }
    if (/(stuck|stalled|aging|waiting|overdue)/.test(t)) { var td = getToday(''); return '⏳ ' + td.stuck.length + ' candidates are past their stage limit:\n' + td.stuck.map(function (s) { return '• ' + s.name + ' — ' + s.stage + ' for ' + s.days + ' days (limit ' + s.sla + 'd) · ' + s.reqId; }).join('\n') + '\n\nAlso ' + td.awaitingFb.length + ' interviews are still waiting on feedback.'; }
    if (/(offer|hired|onboard)/.test(t)) { var of = CANDS.filter(function (x) { return /offer|onboard/i.test(x.stage); }); return '🎁 Offers & hires:\n' + of.map(function (x) { return '• ' + x.name + ' — ' + x.stage + ' · ' + x.reqId + ' ' + req(x.reqId).title; }).join('\n') + '\n\nOffer accept rate so far: ' + analytics('').offerAcceptRate + '%.'; }
    if (/(how many|count|pipeline|summary|summari|status|overview)/.test(t)) {
      var list = rid ? reqCands(rid) : CANDS, counts = {}; list.forEach(function (x) { counts[x.stage] = (counts[x.stage] || 0) + 1; });
      var stageQ = Object.keys(counts).filter(function (s) { return t.indexOf(low(s)) > -1; });
      if (stageQ.length) return '📊 ' + counts[stageQ[0]] + ' candidate' + (counts[stageQ[0]] > 1 ? 's are' : ' is') + ' at ' + stageQ[0] + (rid ? ' for ' + rid : '') + ': ' + list.filter(function (x) { return x.stage === stageQ[0]; }).map(function (x) { return x.name; }).join(', ') + '.';
      return '📊 ' + (rid ? rid + ' · ' + req(rid).title : 'Pipeline overview') + ' — ' + list.length + ' candidates' + (rid ? '' : ' across ' + REQS.length + ' open requisitions') + ':\n' + STAGE_ORDER.concat(['Talent Pool']).filter(function (s) { return counts[s]; }).map(function (s) { return '• ' + s + ': ' + counts[s]; }).join('\n');
    }
    if (c) return '📇 ' + c.name + ' (' + c.candId + ')\n\n' + aiBrief(c.candId);
    if (rid) return processMessage('who are the strongest ' + rid + ' candidates');
    return 'I can answer questions about this (fictional) pipeline. Try:\n• “Who are my strongest backend candidates?”\n• “How many candidates are in Debrief?”\n• “Who is stuck?”\n• “Tell me about Isla Brennan”\n• “Compare Aarav and Diego”\n• “Summarise the data analyst pipeline”';
  }
  var HELP = "Here's what I can do — just say it naturally:\n• Ask about the pipeline — “Who are my strongest backend candidates?”\n• “How many are shortlisted?” · “Who is stuck?”\n• “Tell me about Aarav Menon” · “Compare Aarav and Diego”\n• Create a requisition, add or update candidates, schedule interviews (Meet links) and log feedback — these write actions are read-only in the live demo.";

  /* ------------------------------------------------------------------ write-action helpers */
  function toast(msg) {
    try {
      var el = document.getElementById('demoToast');
      if (!el) { el = document.createElement('div'); el.id = 'demoToast'; document.body.appendChild(el); }
      el.textContent = msg; el.className = 'show'; clearTimeout(toast._t); toast._t = setTimeout(function () { el.className = ''; }, 3200);
    } catch (e) { }
  }
  var SESSION_MSG = 'Demo: applied for this browser tab only — nothing is saved.';
  var DISABLED = function () { toast(DEMO_MSG); return DEMO_MSG; };
  var DISABLED_ERR = function () { toast(DEMO_MSG); return { error: DEMO_MSG }; };
  function session(v) { toast(SESSION_MSG); return v; }

  /* ------------------------------------------------------------------ method table */
  var API = {
    whoAmI: function () { return { email: RECRUITER.email, name: RECRUITER.name, role: 'Admin', title: RECRUITER.title }; },
    getSettings: function () { return { biasMask: STATE.bias }; },
    getOrgContext: function () { return clone(ORG); },
    getAppUrl: function () { return '#demo-source'; },
    getSpreadsheetUrl: function () { return '#demo-sheet'; },
    teamAccess: function () { return { users: TEAM.map(function (u) { return { email: u.email, name: u.name, role: u.role, title: u.title, link: 'https://example.com/agentats/exec?u=demo-' + u.name.split(' ')[0].toLowerCase() }; }), base: 'https://example.com/agentats/exec' }; },
    listHiringManagers: function () { return HMS; },
    listRequisitions: function () { return REQS.map(function (r) { return { id: r.id, label: r.id + ' — ' + r.title }; }); },
    listCandidates: function () { return CANDS.map(function (c) { return { id: c.candId, label: c.name + ' (' + c.candId + ')' }; }); },
    getReqBoard: function (scope) { return board(scope); },
    getToday: function (scope) { return getToday(scope); },
    getPipeline: function () { var st = {}; CANDS.forEach(function (c) { st[c.stage] = (st[c.stage] || 0) + 1; }); return { total: CANDS.length, stages: st, openReqs: REQS.filter(function (r) { return r.status === 'Open'; }).length }; },
    getPipelineView: function (id) { return { summary: reqSummary(id), plan: STATE.plans[id] || '', calibration: CAL[id] || null, workflow: workflow(id), pipeline: getReqPipeline(id), rankTs: RANK_TS[id] || null }; },
    getReqPipeline: function (id) { return getReqPipeline(id); },
    getReqSummary: function (id) { return reqSummary(id); },
    getReqPlan: function (id) { return STATE.plans[id] || ''; },
    getReqAudit: function (id) { var r = req(id); if (!r) return []; return [{ when: fmt(daysAgo(Math.max(1, r.opened - 3), 14, 10)), who: r.recruiter, summary: 'Openings: "1" → "' + r.openings + '"' }, { when: fmt(daysAgo(r.opened, 10, 0)), who: r.recruiter, summary: 'Requisition created' }]; },
    getCalibration: function (id) { return CAL[id] || { reqId: id, files: [], voiceUrl: '', transcript: '', brief: null, notes: '' }; },
    getCandidateFull: candidateFull,
    getCandidateView: candidateFull,
    getInterviews: function (id) { return candidateFull(id).interviews || []; },
    getReqWorkflow: workflow,
    getRankTs: function (id) { return RANK_TS[id] || null; },
    stackRankCached: function (id) { return RANK_TS[id] ? stackRank(id) : { needsRank: true }; },
    stackRankReq: function (id) { RANK_TS[id] = { when: fmtLong(new Date()), who: RECRUITER.name }; return stackRank(id); },
    rankPipelineNow: function (id) { RANK_TS[id] = { when: fmtLong(new Date()), who: RECRUITER.name }; return { ok: true }; },
    rubricRankReq: function (id) {
      var r = req(id), list = reqCands(id); if (!list.length) return { error: 'No candidates on this requisition.' }; var cfg = RUBRIC_CFG[id];
      var ranked = list.map(function (c) { var rb = rubricFor(c), our = rankRow(c, r).score; return { candId: c.candId, name: c.name, composite: rb.composite, our: our, final: Math.round(rb.composite * 0.6 + our * 0.4), verdict: rb.verdict, gate: rb.gate, top: rb.topCategories.slice(0, 3), summary: c.note }; });
      ranked.sort(function (a, b) { if (a.gate !== b.gate) return a.gate ? -1 : 1; return b.final - a.final; });
      return { ranked: ranked, count: ranked.length, total: list.length, role: cfg.role, company: cfg.company, threshold: cfg.threshold, rankedAt: RANK_TS[id] || { when: fmtLong(new Date()), who: RECRUITER.name } };
    },
    scoreCandidateRubric: function (id, regen) { var c = CAND[id]; if (!c) return { error: 'Candidate not found.' }; return rubricFor(c, !!regen); },
    fitScore: function (id) { var c = CAND[id]; if (!c) return { error: 'Candidate not found.' }; if (!c.reqId) return { error: 'Tag this candidate to a requisition first — the fit score is computed against a role.' }; return fitFor(c); },
    getFitPresets: function () { return { presets: FIT_PRESETS, labels: FIT_LABELS, keys: FIT_KEYS }; },
    getFitConfig: function (id) { return FIT_CFG[id] || { archetype: 'Product company', weights: FIT_PRESETS['Product company'] }; },
    saveFitConfig: function (id, arch, w) { if (FIT_CFG[id]) FIT_CFG[id] = { archetype: arch, weights: w }; toast(SESSION_MSG); return '✅ Fit weights updated for ' + id + ' (demo — this tab only).'; },
    getRubricConfig: function (id) { return RUBRIC_CFG[id] || null; },
    setRubricConfig: function (id, role, company, th) { RUBRIC_CFG[id] = { role: role || 'General', company: company || 'Mid-cap SaaS', threshold: th || 'Balanced' }; return session({ ok: true, cfg: RUBRIC_CFG[id] }); },
    tr_options: function () { return { archetypes: ENGINE.archetypes, companies: ENGINE.companies, thresholds: Object.keys(ENGINE.thresholds) }; },
    tr_categories: function () { return ENGINE.categories; },
    getSuccessProfile: function (id) { var r = req(id); return r ? clone(r.sp) : { error: 'Requisition not found.' }; },
    getSuccessContext: function (id) { var r = req(id); return r ? r.hm + ': ' + r.sp.summary + ' ' + (r.notes || '') : ''; },
    getBenchmark: function (id) {
      var r = req(id); if (!r) return { error: 'Requisition not found.' };
      return { ideal_profile: r.sp.summary + ' Typically ' + r.sp.exp_min + '–' + r.sp.exp_max + ' years with ' + r.sp.core_skills.slice(0, 4).join(', ') + '.', by_level: r.level + ': owns outcomes for a well-scoped area; ' + (r.level === 'Manager' || r.level === 'Lead' ? 'grows people and sets direction for the team.' : 'raises the bar for peers through reviews and design docs.'),
        must_have_signals: r.must.map(function (m) { return m.label; }).concat(['Quantified impact in the last two roles']), red_flags: r.flags.concat(['Vague answers about personal contribution']),
        sample_questions: ['Walk me through the most complex ' + (r.department === 'Engineering' ? 'system' : 'project') + ' you owned end-to-end — what would you change now?', 'Tell me about a time you disagreed with a stakeholder on priorities. What happened?', 'How do you measure whether your work in a ' + r.title.toLowerCase() + ' role is succeeding?'] };
    },
    graphMatch: function (id) { var c = CAND[id]; return c ? graph(c) : { error: 'Candidate not found.' }; },
    inferSkills: function (id) { var c = CAND[id]; return c ? skillsFor(c) : { error: 'Candidate not found.' }; },
    aiBrief: aiBrief,
    reqBrief: reqBrief,
    candidateStory: function (o) { var c = findCand(low((o && o.name) || '')); return c ? aiBrief(c.candId) : 'Candidate not found.'; },
    generateDebrief: debrief,
    getAnalytics: analytics,
    getRoundMetrics: roundMetrics,
    getStageMetrics: STAGE_METRICS,
    pipelineInsights: insights,
    rediscoverTalent: rediscover,
    globalSearch: search,
    searchSuggest: suggest,
    processMessage: processMessage,
    getArchive: function (q) {
      var rows = [['C-0907', 'Rahel Mengistu', 'Debrief Reject', 'Backend Engineer', 'Brightloop', 6, 'Bengaluru', 'REQ-091', 190], ['C-0911', 'Oskar Brandt', 'Onboarded', 'Data Analyst', 'Pinecrest Analytics', 4, 'Pune', 'REQ-088', 240], ['C-0923', 'Lina Sato', 'CV Screen Reject', 'QA Engineer', 'Craneworks', 3, 'Chennai', 'REQ-093', 150], ['C-0931', 'Farid Haidari', 'Offer Declined', 'Product Manager', 'Quantiva', 7, 'Remote', 'REQ-094', 132]]
        .map(function (a) { return { candId: a[0], name: a[1], stage: a[2], title: a[3], company: a[4], exp: a[5], location: a[6], reqId: a[7], received: fmt(daysAgo(a[8])).slice(0, 10), email: a[1].toLowerCase().replace(/[^a-z]+/g, '.') + '@example.com', phone: '+1 555 01' + a[0].slice(-2) }; });
      var ql = low(q); if (ql) rows = rows.filter(function (r) { return low(JSON.stringify(r)).indexOf(ql) > -1; });
      return { rows: rows, count: rows.length };
    },
    getJobArch: function () {
      return { companyTypes: ['Product / SaaS', 'E-commerce / Marketplace', 'Internet / Consumer', 'IT Services / Consulting', 'Mid-cap / Enterprise', 'AI / ML', 'Fintech', 'Fintech AI', 'BFSI / Banking', 'Industrial / Manufacturing AI', 'Healthcare / Pharma', 'Deep Tech / R&D', 'Early-stage Startup', 'Other'], companyType: 'Product / SaaS',
        tech: { families: [{ family: 'Software Engineering', levels: [{ level: 'SDE I', minYears: '0', maxYears: '2', scope: 'Well-defined tasks with guidance' }, { level: 'SDE II', minYears: '2', maxYears: '5', scope: 'Owns features end-to-end' }, { level: 'Senior SDE', minYears: '5', maxYears: '9', scope: 'Owns services; mentors' }, { level: 'Staff Engineer', minYears: '9', maxYears: '15', scope: 'Cross-team technical direction' }] }, { family: 'Engineering Management', levels: [{ level: 'Engineering Manager', minYears: '8', maxYears: '14', scope: 'One team of 5–10' }, { level: 'Senior EM', minYears: '12', maxYears: '18', scope: 'Multiple teams' }] }] },
        nontech: { families: [{ family: 'Customer Success', levels: [{ level: 'CSM', minYears: '2', maxYears: '5', scope: 'Book of accounts' }, { level: 'CS Lead', minYears: '5', maxYears: '10', scope: 'Pod of CSMs; renewals' }] }] } };
    },
    recommendJobArch: function (type, track) { return track === 'nontech' ? { families: [{ family: 'Customer Success', levels: [{ level: 'Associate CSM', minYears: '0', maxYears: '2', scope: 'Onboarding support' }, { level: 'CSM', minYears: '2', maxYears: '5', scope: 'Owns a book of accounts' }, { level: 'CS Lead', minYears: '5', maxYears: '10', scope: 'Leads a pod; owns renewals' }] }, { family: 'Talent Acquisition', levels: [{ level: 'Recruiter', minYears: '2', maxYears: '5', scope: 'Owns 6–10 reqs' }, { level: 'Senior Recruiter', minYears: '5', maxYears: '9', scope: 'Leadership hiring; HM partnership' }] }] } : { families: [{ family: 'Software Engineering', levels: [{ level: 'SDE I', minYears: '0', maxYears: '2', scope: 'Well-scoped tasks' }, { level: 'SDE II', minYears: '2', maxYears: '5', scope: 'Owns features' }, { level: 'Senior SDE', minYears: '5', maxYears: '9', scope: 'Owns services; mentors' }, { level: 'Staff', minYears: '9', maxYears: '15', scope: 'Org-wide technical direction' }] }, { family: 'Data & Analytics', levels: [{ level: 'Analyst', minYears: '1', maxYears: '3', scope: 'Reporting & ad-hoc analysis' }, { level: 'Senior Analyst', minYears: '3', maxYears: '6', scope: 'Experimentation; owns a domain' }] }] }; },
    getCompanyTuning: function (co) { var st = {}, m = ENGINE.companyModifiers[co] || []; ENGINE.categories.forEach(function (c, i) { var v = Number(m[i] || 1); st[c] = (STATE.tuning[co] && STATE.tuning[co][c]) || (v >= 1.3 ? 'boost' : v <= 0.8 ? 'dampen' : 'neutral'); }); return { company: co, categories: ENGINE.categories, state: st, hasOverride: !!STATE.tuning[co] }; },
    tuneCompanyByText: function (co, text) {
      var base = API.getCompanyTuning(co), t = low(text), st = base.state;
      var MAP = [['domain', 'Domain & Industry Expertise'], ['certif', 'Certifications & Licenses'], ['stabil', 'Tenure & Stability'], ['tenure', 'Tenure & Stability'], ['pedigree', 'Employer Pedigree & Company Signals'], ['publication', 'Publications, Patents & Research'], ['patent', 'Publications, Patents & Research'], ['leader', 'Leadership & People Management'], ['impact', 'Achievement & Impact Quantification'], ['skill', 'Technical Skills – Breadth & Depth'], ['communic', 'Language & Communication'], ['education', 'Education – Institution'], ['portfolio', 'Projects & Portfolio'], ['sales', 'Sales & Commercial Performance']];
      var parts = t.split(/de-?emphasi[sz]e|downplay|ignore|less weight on/); var pos = parts[0], neg = parts.slice(1).join(' ');
      MAP.forEach(function (m) { if (pos.indexOf(m[0]) > -1) st[m[1]] = 'boost'; if (neg.indexOf(m[0]) > -1) st[m[1]] = 'dampen'; });
      return { categories: base.categories, state: st };
    },
    setCompanyTuning: function (co, st) { STATE.tuning[co] = st; return session({ ok: true }); },
    resetCompanyTuning: function (co) { delete STATE.tuning[co]; return session({ ok: true }); },
    getWeightMode: function () { return { custom: STATE.weightsCustom }; },
    getWeightAudit: function () { return [{ when: fmt(daysAgo(12, 16, 40)), who: 'Jordan Blake', summary: 'Switched to recommended weights (scope: new candidates only)' }, { when: fmt(daysAgo(30, 11, 5)), who: 'Jordan Blake', summary: 'Boosted Domain & Industry Expertise for Mid-cap SaaS' }]; },
    changeWeights: function (custom, scope) { STATE.weightsCustom = !!custom; return session({ ok: true, scope: scope }); },
    rerankerStatus: function () { return { configured: false }; },
    checkDuplicate: function (o) { var e = low(o && o.email); var c = e ? CANDS.filter(function (x) { return x.email === e; })[0] : null; return c ? { dup: true, via: 'email', name: c.name, candId: c.candId, reqId: c.reqId, stage: c.stage } : { dup: false }; },
    checkRsvp: function () { return '<span style="color:#1f7a4d">accepted ✓</span> (all guests)'; },
    checkAvailability: function (ivs, dt) { var list = String(ivs || '').split(/[,;\s]+/).filter(function (x) { return x.indexOf('@') > -1; }); return { results: list.map(function (e, i) { return { email: e, free: (hash(e + dt) % 4) !== 0 || i === 0 }; }) }; },
    freeSlots: function (ivs) {
      var n = String(ivs || '').split(/[,;\s]+/).filter(function (x) { return x.indexOf('@') > -1; }).length || 1, slots = [], d = new Date(NOW), added = 0;
      while (added < 4) { d = new Date(d.getTime() + 86400000); if (d.getDay() === 0 || d.getDay() === 6) continue; added++; [10, 11, 14, 15, 16].forEach(function (h, i) { if ((hash(d.toDateString() + h) % 3) === 0 && i % 2) return; var s = new Date(d); s.setHours(h, 0, 0, 0); slots.push({ day: DOW[s.getDay()] + ' ' + z(s.getDate()) + ' ' + MON[s.getMonth()], time: z(h) + ':00', iso: s.getFullYear() + '-' + z(s.getMonth() + 1) + '-' + z(s.getDate()) + 'T' + z(h) + ':00' }); }); }
      return { slots: slots, workStart: ORG.workStart, workEnd: ORG.workEnd, slotMin: ORG.slotMin, interviewers: n, note: 'Demo calendars — slots are illustrative.' };
    },
    suggestInterviewPlan: function (id) { var r = req(id); return (r && r.plan) || plan([{ name: 'Screening', type: 'recruiter', competencies: ['Motivation', 'Logistics'] }, { name: 'Technical', type: 'technical', competencies: ['Kubernetes', 'Terraform', 'Debugging under pressure'] }, { name: 'Incident Simulation', type: 'case', competencies: ['Incident response', 'Communication'] }, { name: 'Hiring Manager', type: 'hiring_manager', competencies: ['Ownership', 'Collaboration'] }]); },
    saveReqPlan: function (id, j) { STATE.plans[id] = j; return session({ ok: true }); },
    draftCandidateEmail: function (id, kind) {
      var c = CAND[id] || { name: 'there' }, r = req(c.reqId) || { title: 'the role' }, f = first(c.name);
      var T = { advance: ['Next steps — ' + r.title, 'Hi ' + f + ',\n\nThank you for your time so far — the team really enjoyed the conversation. We would love to move you to the next round for the ' + r.title + ' role.\n\nCould you share two or three windows that work for you next week? I will send a calendar invite with the details.\n\nBest,\n' + RECRUITER.name], reject: ['Your application — ' + r.title, 'Hi ' + f + ',\n\nThank you for the time and care you put into the process for the ' + r.title + ' role. After a lot of discussion, we have decided to move forward with candidates whose experience more closely matches what the team needs right now.\n\nThis was a close call, and we would genuinely like to stay in touch for future roles.\n\nWarm regards,\n' + RECRUITER.name], offer: ['Offer — ' + r.title, 'Hi ' + f + ',\n\nI am delighted to share that we would like to offer you the ' + r.title + ' role! The team was unanimous.\n\nI will send the formal offer letter shortly — could we find 20 minutes tomorrow to walk through it together?\n\nCongratulations,\n' + RECRUITER.name], thanks: ['Thank you for interviewing', 'Hi ' + f + ',\n\nThank you for interviewing with us for the ' + r.title + ' role. We are collecting feedback from the panel and will be back to you within three working days.\n\nBest,\n' + RECRUITER.name] };
      var x = T[kind] || T.thanks; return { subject: x[0], body: x[1] };
    },
    polishFeedback: function (raw) { var s = String(raw || '').replace(/\s+/g, ' ').trim(); s = s.replace(/(^|[.!?]\s+)([a-z])/g, function (m, a, b) { return a + b.toUpperCase(); }).replace(/\bi\b/g, 'I'); if (s && !/[.!?]$/.test(s)) s += '.'; return { text: s }; },
    parseResumeOnly: function () { return { firstName: 'Riya', lastName: 'Sandoval', email: 'riya.sandoval@example.com', phone: '+1 555 0177', location: 'Bengaluru', company: 'Northwind Labs', title: 'Backend Engineer', experience: '5', skills: 'Go, PostgreSQL, Kafka, Docker, AWS', qualification: 'B.Tech Computer Science — Ridgeview University (2020)', notice: '60', currentCTC: 'INR 2600000', expectedCTC: 'INR 3400000', offerInHand: 'No', gender: '', resume: '', lowConfidence: false, highlights: 'Sample CV parsed by the demo — upload is not stored.' }; },
    parseJD: DISABLED_ERR,
    lookupResearch: function (id) { var c = CAND[id]; return { name: c ? c.name : '', scholars: [], patents: [], patentNote: 'Live OpenAlex / PatentsView lookups are disabled in the demo (sample candidates are fictional).' }; },
    verifyGitHub: function () { return { error: 'Live GitHub verification is disabled in the demo — sample candidates are fictional.' }; },
    setBiasMask: function (on) { STATE.bias = !!on; return { biasMask: STATE.bias }; },
    recordDebriefDecision: function (id, dec) { var c = CAND[id]; if (c) { c.stage = dec === 'Advance' ? 'Selected' : dec === 'Hold' ? 'On Hold' : 'Debrief Reject'; c.inStage = 0; } return session({ ok: true }); },
    saveInterviewFeedback: function (o) { var c = CAND[o && o.candId]; if (c) FEEDBACK.push({ candId: c.candId, when: fmt(new Date()), interviewer: o.interviewer || RECRUITER.name, stage: o.stage || 'Interview', rating: String(o.rating || ''), recommendation: o.recommendation || '', strengths: '', concerns: '', feedback: o.feedback || '', source: 'In-app (demo)' }); return session({ ok: true }); },
    saveCalibrationNotes: function (id, t) { if (CAL[id]) CAL[id].notes = t; return session({ ok: true }); },
    setCalibrationFromText: function (id, t) { if (CAL[id]) { CAL[id].brief = CAL[id].brief || { must_haves: [], nice_to_haves: [], red_flags: [], summary: '' }; String(t || '').split(/[;,]/).map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 4).forEach(function (s) { if (CAL[id].brief.must_haves.indexOf(s) < 0) CAL[id].brief.must_haves.push(s); }); } return session({ ok: true }); },
    setSuccessContext: function () { return session({ ok: true }); },
    saveResearch: function () { return session({ ok: true }); },
    editCandidate: function () { toast(DEMO_MSG); return { ok: true, changed: 0 }; },
    editRequisition: function () { toast(DEMO_MSG); return { ok: true, changed: 0 }; },
    setOrgContext: function () { toast(DEMO_MSG); return { ok: false, error: DEMO_MSG }; },
    setJobArch: function () { return session({ ok: true }); },
    addTeamMember: DISABLED_ERR, saveHiringManager: DISABLED_ERR, removeHiringManager: DISABLED_ERR, saveLogo: DISABLED_ERR,
    removeTeamMember: function () { toast(DEMO_MSG); return API.teamAccess(); },
    addCalibrationFile: DISABLED_ERR, addCalibrationVoice: DISABLED_ERR, addSuccessVoice: DISABLED_ERR,
    candidatePacketPdf: DISABLED_ERR, notebookPack: DISABLED_ERR, enableCustomWeights: DISABLED_ERR, restoreCandidate: DISABLED_ERR,
    publishRubricWeightTabs: function () { toast(DEMO_MSG); return { message: DEMO_MSG }; },
    archiveOldCandidates: function () { toast(DEMO_MSG); return { message: DEMO_MSG }; },
    buildDashboardData: function () { toast(DEMO_MSG); return '✅ In your install this rebuilds the “Dashboard Data” tab for Looker Studio. ' + DEMO_MSG; },
    emailAnalyticsReport: DISABLED, testChatNotify: DISABLED, importFeedbackFromEmail: DISABLED, sendCandidateEmail: DISABLED, scheduleInterview2: DISABLED, rescheduleInterview: DISABLED,
    saveRequisition: DISABLED, saveCandidateDetails: DISABLED, saveReviewedCandidate: DISABLED, addCandidateManual: DISABLED, uploadCV: DISABLED, tagCandidateToReq: DISABLED,
    reparseCandidate: function () { toast(DEMO_MSG); return '🔄 Re-parse is disabled in the live demo — the sample profile is already complete.'; }
  };
  var CALLED = {};
  window.__demoCalls = CALLED;
  window.__demoErrors = [];
  var SLOW = { stackRankReq: 1, rubricRankReq: 1, scoreCandidateRubric: 1, fitScore: 1, aiBrief: 1, reqBrief: 1, processMessage: 1, generateDebrief: 1, graphMatch: 1, inferSkills: 1, rediscoverTalent: 1, suggestInterviewPlan: 1, draftCandidateEmail: 1, getBenchmark: 1 };
  var INSTANT = { getOrgContext: 1, getSettings: 1 };

  function dispatch(name, args, ok, fail, uo) {
    CALLED[name] = (CALLED[name] || 0) + 1;
    args = Array.prototype.slice.call(args).filter(function (a) { return !(typeof a === 'string' && a.indexOf('#tok:') === 0); });
    var res, err = null;
    try {
      var fn = API[name];
      if (typeof fn === 'function') res = fn.apply(null, args);
      else { res = DEMO_MSG; toast(DEMO_MSG); if (window.console) console.info('[demo] unmocked method → friendly message:', name); }
      res = clone(res === undefined ? null : res);
    } catch (e) { err = e; }
    var delay = INSTANT[name] ? 0 : SLOW[name] ? 650 + Math.random() * 350 : 250 + Math.random() * 250;
    var run = function () {
      try {
        if (err) { if (fail) fail(err, uo); }
        else if (ok) ok(res, uo);
      } catch (e) { window.__demoErrors.push(name + ': ' + (e && e.message)); if (window.console) console.error('[demo] handler for ' + name + ' threw', e); }
    };
    if (INSTANT[name]) Promise.resolve().then(run); else setTimeout(run, delay);
  }
  function runner(ok, fail, uo) {
    return new Proxy({}, {
      get: function (t, k) {
        if (typeof k !== 'string' || k === 'then' || k === 'toJSON') return undefined;
        if (k === 'withSuccessHandler') return function (f) { return runner(f, fail, uo); };
        if (k === 'withFailureHandler') return function (f) { return runner(ok, f, uo); };
        if (k === 'withUserObject') return function (o) { return runner(ok, fail, o); };
        return function () { dispatch(k, arguments, ok, fail, uo); };
      }
    });
  }
  window.google = window.google || {};
  window.google.script = {
    get run() { return runner(null, null, undefined); },
    host: { close: function () { }, setHeight: function () { }, setWidth: function () { }, origin: location.origin, editor: { focus: function () { } } },
    url: { getLocation: function (cb) { var p = {}; try { new URLSearchParams(location.search).forEach(function (v, k) { p[k] = v; }); } catch (e) { } setTimeout(function () { cb({ hash: location.hash.replace(/^#/, ''), parameter: p, parameters: Object.keys(p).reduce(function (a, k) { a[k] = [p[k]]; return a; }, {}) }); }, 0); } },
    history: { push: function () { }, replace: function () { }, setChangeHandler: function () { } }
  };
  window._bias = false;

  /* ------------------------------------------------------------------ demo chrome: banner, toast, link guards */
  try { document.title = 'AgentATS — Live demo'; } catch (e) { }
  var css = '#demoBar{flex:none;display:flex;align-items:center;justify-content:center;gap:10px;padding:7px 40px 7px 14px;background:#141318;color:#EDEBF2;font:500 13px/1.35 "Hanken Grotesk",system-ui,sans-serif;position:relative;z-index:12;text-align:center}' +
    '#demoBar b{color:#fff;font-weight:700}#demoBar a{color:#C9BDFF;font-weight:700;text-decoration:underline;text-underline-offset:2px;white-space:nowrap}#demoBar a:hover{color:#fff}' +
    '#demoBar .dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#13A463;box-shadow:0 0 0 3px rgba(19,164,99,.25);margin-right:2px;vertical-align:1px}' +
    '#demoBarX{position:absolute;right:8px;top:50%;transform:translateY(-50%);background:transparent;border:0;color:#9C97AC;font-size:18px;line-height:1;cursor:pointer;padding:4px 8px;border-radius:6px}#demoBarX:hover{color:#fff;background:rgba(255,255,255,.08)}' +
    'body.demo-bar #overlay{top:var(--demo-bar-h,34px)}' +
    '#demoToast{position:fixed;left:50%;bottom:86px;transform:translate(-50%,20px);background:#141318;color:#fff;font:500 13px/1.4 "Hanken Grotesk",system-ui,sans-serif;padding:10px 16px;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.25);opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;z-index:50;max-width:min(92vw,520px);text-align:center}#demoToast.show{opacity:1;transform:translate(-50%,0)}' +
    '@media(max-width:640px){#demoBar{font-size:12px;padding:6px 34px 6px 10px}#demoBar .long{display:none}}';
  function mountChrome() {
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    var hidden = false; try { hidden = sessionStorage.getItem('agentats-demo-bar') === 'hidden'; } catch (e) { }
    if (!hidden) {
      var bar = document.createElement('div'); bar.id = 'demoBar'; bar.setAttribute('role', 'note');
      bar.innerHTML = '<span><span class="dot"></span> <b>Live demo</b> · fictional sample data · nothing is saved <span class="long">—</span> <a href="' + GITHUB + '" target="_blank" rel="noopener">Get AgentATS free on GitHub</a></span><button id="demoBarX" type="button" aria-label="Dismiss demo banner">×</button>';
      document.body.insertBefore(bar, document.body.firstChild); document.body.classList.add('demo-bar');
      var setH = function () { document.documentElement.style.setProperty('--demo-bar-h', bar.offsetHeight + 'px'); };
      setH(); window.addEventListener('resize', setH);
      document.getElementById('demoBarX').onclick = function () { bar.remove(); document.body.classList.remove('demo-bar'); try { sessionStorage.setItem('agentats-demo-bar', 'hidden'); } catch (e) { } };
    }
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href^="#demo"]') : null;
      if (a) { e.preventDefault(); e.stopPropagation(); toast(a.getAttribute('href') === '#demo-meet' ? 'Google Meet links are created in your own install — not in the demo.' : 'Files and links aren’t stored in the live demo — sample candidates are fictional.'); }
    }, true);
  }
  var _open = window.open;
  window.open = function (u) { if (!u || String(u).indexOf('#demo') === 0 || String(u).indexOf('?page=') > -1) { toast(String(u).indexOf('page=source') > -1 ? 'The sourcing workspace opens in a new tab of your own install — not in the live demo.' : 'Opening Google Sheets / Docs / Drive is disabled in the live demo.'); return null; } return _open.apply(window, arguments); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountChrome); else mountChrome();
})();
