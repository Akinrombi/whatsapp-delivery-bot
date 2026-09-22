const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// Initialize Supabase
const SUPABASE_URL = 'https://glkutdkwbrjpiuqcmgwe.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdsa3V0ZGt3YnJqcGl1cWNtZ3dlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk5NzU3MTMsImV4cCI6MjEwNTU1MTcxM30.f2SgZJvP681imm0Qe1fKsATnCk_86z2guwvZWASXoZM';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Helper function to build restaurant list from Supabase
async function getRestaurantListText() {
  let stores = [];
  try {
    const { data, error } = await supabase.from('vendors').select('*');
    if (!error && data && data.length > 0) {
      stores = data;
    }
  } catch (err) {
    console.error('Supabase query error:', err);
  }

  if (stores.length === 0) {
    return "🍽️ *AVAILABLE RESTAURANTS*\n\n1. Chicken Republic\n2. Mega Chicken\n3. Mama Cass\n\nReply with the restaurant name or number to view menu!";
  }

  let text = "🍽️ *AVAILABLE RESTAURANTS*\n\n";
  stores.forEach((s, index) => {
    text += `${index + 1}. *${s.store_name || s.name}*\n_${s.description || 'Fresh & fast delivery'}_\n\n`;
  });
  text += "Reply with the restaurant number to see their menu!";
  return text;
}

// HTTP Endpoint test
app.get('/', (req, res) => res.send('Admin Bot Active'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));