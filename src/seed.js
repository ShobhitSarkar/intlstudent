'use strict';

/**
 * Sample data so the app has something to show on first run.
 *
 * Tuition figures are ROUGH, ILLUSTRATIVE numbers for a year of undergraduate study as an
 * international student. They are not authoritative — replace them with figures from each
 * university (or have its representatives update them in the app) before relying on them.
 */

const { hashPassword } = require('./auth');

const UNIVERSITIES = [
  ['University of Toronto', 'Toronto', 'Ontario', 'Canada', 'https://www.utoronto.ca', 'utoronto.ca', 62000, 'CAD', 45500, '#1E3765'],
  ['University of British Columbia', 'Vancouver', 'British Columbia', 'Canada', 'https://www.ubc.ca', 'ubc.ca', 50000, 'CAD', 36700, '#002145'],
  ['McGill University', 'Montreal', 'Quebec', 'Canada', 'https://www.mcgill.ca', 'mcgill.ca', 50000, 'CAD', 36700, '#ED1B2F'],
  ['Iowa State University', 'Ames', 'Iowa', 'United States', 'https://www.iastate.edu', 'iastate.edu', 28000, 'USD', 28000, '#C8102E'],
  ['University of Michigan', 'Ann Arbor', 'Michigan', 'United States', 'https://umich.edu', 'umich.edu', 60000, 'USD', 60000, '#00274C'],
  ['Arizona State University', 'Tempe', 'Arizona', 'United States', 'https://www.asu.edu', 'asu.edu', 34000, 'USD', 34000, '#8C1D40'],
  ['University of Manchester', 'Manchester', 'England', 'United Kingdom', 'https://www.manchester.ac.uk', 'manchester.ac.uk', 28000, 'GBP', 35500, '#660099'],
  ['University of Edinburgh', 'Edinburgh', 'Scotland', 'United Kingdom', 'https://www.ed.ac.uk', 'ed.ac.uk', 29000, 'GBP', 36800, '#041E42'],
  ['University of Melbourne', 'Melbourne', 'Victoria', 'Australia', 'https://www.unimelb.edu.au', 'unimelb.edu.au', 48000, 'AUD', 31500, '#094183'],
  ['UNSW Sydney', 'Sydney', 'New South Wales', 'Australia', 'https://www.unsw.edu.au', 'unsw.edu.au', 52000, 'AUD', 34000, '#1A1A1A'],
  ['Technical University of Munich', 'Munich', 'Bavaria', 'Germany', 'https://www.tum.de', 'tum.de', 6000, 'EUR', 6500, '#3070B3'],
  ['National University of Singapore', 'Singapore', null, 'Singapore', 'https://nus.edu.sg', 'nus.edu.sg', 38000, 'SGD', 28500, '#003D7C'],
];

const DEMO_PASSWORD = 'password123';

function seedIfEmpty(db, { log = true } = {}) {
  if (db.prepare('SELECT COUNT(*) AS n FROM universities').get().n > 0) return false;

  db.exec('BEGIN');
  try {
    const insUni = db.prepare(
      `INSERT INTO universities (name, city, state_province, country, website, email_domain,
         intl_tuition_amount, tuition_currency, intl_tuition_usd, brand_color, contact_email, description, tuition_notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const uniIds = {};
    for (const [name, city, region, country, website, domain, amount, currency, usd, color] of UNIVERSITIES) {
      const { lastInsertRowid } = insUni.run(
        name, city, region, country, website, domain, amount, currency, usd, color,
        `international@${domain}`,
        `${name} in ${city}, ${country}. (Sample description — the university's representatives can replace this.)`,
        'Sample figure: approximate yearly undergraduate tuition for international students. Check the university website.'
      );
      uniIds[name] = Number(lastInsertRowid);
    }

    const hash = hashPassword(DEMO_PASSWORD);
    const insUser = db.prepare(
      `INSERT INTO users (email, display_name, password_hash, role, university_id, rep_status,
         bio, home_country, home_city, program, intake, grad_year)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const user = (email, name, role, uni, extra = {}) =>
      Number(
        insUser.run(
          email, name, hash, role, uni ? uniIds[uni] : null, role === 'university_rep' ? 'approved' : null,
          extra.bio ?? null, extra.country ?? null, extra.city ?? null, extra.program ?? null,
          extra.intake ?? null, extra.gradYear ?? null
        ).lastInsertRowid
      );

    const admin = user('admin@intlstudent.test', 'Site Admin', 'admin', null);
    const priya = user('priya@example.com', 'Priya', 'prospective', null, {
      bio: 'Looking at CS programs in Canada and the US. Happy to share notes on visas and scholarships!',
      country: 'India', city: 'Pune', program: 'BSc Computer Science', intake: 'Fall 2027',
    });
    const arjun = user('arjun@example.com', 'Arjun', 'prospective', null, {
      bio: 'Engineering hopeful. Trying to figure out cost of living in Toronto vs Vancouver.',
      country: 'India', city: 'Mumbai', program: 'Mechanical Engineering', intake: 'Fall 2027',
    });
    const chen = user('chen@example.com', 'Chen', 'prospective', null, {
      bio: 'Interested in business programs.', country: 'China', city: 'Shanghai', program: 'Commerce', intake: 'Fall 2027',
    });
    const maria = user('maria@utoronto.ca', 'Maria', 'student', 'University of Toronto', {
      bio: 'Third-year CS student from Brazil. Ask me about residence life and co-op!',
      country: 'Brazil', city: 'São Paulo', program: 'BSc Computer Science', gradYear: 2028,
    });
    const rahul = user('rahul@iastate.edu', 'Rahul', 'student', 'Iowa State University', {
      bio: 'Grad student in ECE, originally from Hyderabad.', country: 'India', city: 'Hyderabad',
      program: 'MS Electrical Engineering', gradYear: 2027,
    });
    const torontoRep = user('admissions@utoronto.ca', 'U of T International Admissions', 'university_rep', 'University of Toronto');

    const insTarget = db.prepare('INSERT INTO user_target_universities (user_id, university_id) VALUES (?, ?)');
    for (const [u, unis] of [
      [priya, ['University of Toronto', 'University of British Columbia', 'Iowa State University']],
      [arjun, ['University of Toronto', 'University of British Columbia']],
      [chen, ['University of Melbourne', 'National University of Singapore']],
    ]) {
      for (const n of unis) insTarget.run(u, uniIds[n]);
    }

    const insQ = db.prepare('INSERT INTO questions (university_id, user_id, title, body) VALUES (?, ?, ?, ?)');
    const insA = db.prepare('INSERT INTO answers (question_id, user_id, body) VALUES (?, ?, ?)');
    const q1 = Number(
      insQ.run(
        uniIds['University of Toronto'], priya,
        'Is first-year residence guaranteed for international students?',
        "I'm applying for Fall 2027. Do international students get guaranteed residence in first year, and when do applications open?"
      ).lastInsertRowid
    );
    insA.run(q1, maria, 'I got a spot in first year. Apply as soon as the portal opens after you accept your offer — the good ones go fast.');
    insA.run(
      q1, torontoRep,
      'First-year students who meet the residence application deadline are guaranteed a space. Details are posted on our housing site each spring.'
    );
    const q2 = Number(
      insQ.run(
        uniIds['Iowa State University'], priya,
        'How easy is it to find on-campus jobs?',
        'Do international students on F-1 visas usually find on-campus work in their first semester?'
      ).lastInsertRowid
    );
    insA.run(q2, rahul, 'Dining services and the library hire a lot each semester. I had a job within my first month.');
    insQ.run(
      uniIds['University of British Columbia'], arjun,
      'Cost of living in Vancouver for students?',
      'What is a realistic monthly budget for rent and food near campus?'
    );

    // An accepted connection with a short conversation, plus a pending request.
    const c1 = Number(
      db.prepare("INSERT INTO connections (requester_id, addressee_id, status, note, responded_at) VALUES (?, ?, 'accepted', ?, datetime('now'))")
        .run(priya, maria, 'Hi Maria! I am applying to U of T CS for Fall 2027.').lastInsertRowid
    );
    const insM = db.prepare('INSERT INTO messages (connection_id, sender_id, body) VALUES (?, ?, ?)');
    insM.run(c1, priya, 'Thanks for connecting! How did you find the first-year CS courses?');
    insM.run(c1, maria, 'Challenging but fun. Happy to tell you more — what else are you wondering about?');
    db.prepare('INSERT INTO connections (requester_id, addressee_id, note) VALUES (?, ?, ?)').run(
      arjun, priya, 'Hey, we are both looking at Toronto and UBC — want to compare notes?'
    );

    db.exec('COMMIT');
    // Grant permissions for the demo data (normally written alongside each change by the routes).
    require('./authz').backfillTuples(db);
    if (log) {
      console.log(`Seeded sample data. Demo accounts (password "${DEMO_PASSWORD}"):`);
      console.log('  priya@example.com       prospective student');
      console.log('  maria@utoronto.ca       current student, University of Toronto');
      console.log('  admissions@utoronto.ca  University of Toronto representative');
      console.log('  admin@intlstudent.test  site admin');
    }
    return { admin };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { seedIfEmpty, DEMO_PASSWORD };

if (require.main === module) {
  const { openDb } = require('./db');
  if (!seedIfEmpty(openDb())) console.log('Database already has data; nothing to do.');
}
