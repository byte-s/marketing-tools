const express = require('express');
const { getLiveSnapshot } = require('../liveData');

const router = express.Router();

router.get('/', async (req, res) => {
  const snapshot = await getLiveSnapshot({ dateFrom: req.query.dateFrom, dateTo: req.query.dateTo });
  res.json(snapshot);
});

module.exports = router;
