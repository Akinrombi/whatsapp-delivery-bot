// Zenzora WhatsApp passenger ride booking.
// Uses the existing ride_requests table; no fare is invented or charged here.
module.exports = function createRideBookingHandler({ supabase, sendText }) {
  const activeStatuses = ['SEARCHING', 'ACCEPTED', 'ARRIVED_PICKUP', 'IN_PROGRESS', 'ARRIVED', 'IN_TRANSIT'];

  async function notifyRideCustomers() {
    const { data: trips, error } = await supabase
      .from('ride_requests')
      .select('id, customer_phone, status, customer_notified_status, pickup_address, destination_address')
      .in('status', ['ACCEPTED', 'ARRIVED_PICKUP', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'ARRIVED', 'IN_TRANSIT'])
      .limit(50);
    if (error) {
      console.error('Ride customer notification lookup failed:', error.message);
      return;
    }
    for (const trip of trips || []) {
      const status = String(trip.status || '').toUpperCase();
      if (!trip.customer_phone || status === String(trip.customer_notified_status || '').toUpperCase()) continue;
      const messages = {
        ACCEPTED: '🚗 A Zenzora driver has accepted your ride request. Please keep your phone nearby.',
        ARRIVED_PICKUP: '📍 Your Zenzora driver has arrived at the pickup point.',
        ARRIVED: '📍 Your Zenzora driver has arrived at the pickup point.',
        IN_PROGRESS: '🚘 Your Zenzora trip has started. Have a safe journey.',
        IN_TRANSIT: '🚘 Your Zenzora trip is in progress. Have a safe journey.',
        COMPLETED: '✅ Your Zenzora ride is marked completed. Thank you for riding with us.',
        CANCELLED: 'Your Zenzora ride request has been cancelled.'
      };
      const message = messages[status];
      if (!message) continue;
      const sent = await sendText(trip.customer_phone, message);
      if (!sent) continue;
      const { error: updateError } = await supabase
        .from('ride_requests')
        .update({ customer_notified_status: status })
        .eq('id', trip.id)
        .eq('customer_notified_status', trip.customer_notified_status);
      if (updateError) console.error('Ride customer notification status update failed:', updateError.message);
    }
  }

  async function handleRideBookingMessage({ from, text, textLower, listId, btnId, location, session }) {
    const state = session.rideBooking || null;
    if (state && ['cancel', 'cancel ride'].includes(textLower)) {
      delete session.rideBooking;
      await sendText(from, 'Your ride booking has been cancelled. Send *menu* to return to Zenzora services.');
      return true;
    }

    if (listId === 'service_ride' || /^(book a ride|ride|car ride|taxi)$/i.test(textLower)) {
      const { data: existing, error: existingError } = await supabase
        .from('ride_requests')
        .select('id, status')
        .eq('customer_phone', from)
        .in('status', activeStatuses)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existingError) {
        console.error('Existing ride request lookup failed:', existingError.message);
        await sendText(from, 'I cannot check your existing ride request right now. Please try again shortly.');
        return true;
      }
      if (existing) {
        await sendText(from, 'You already have a ride request in progress (status: ' + existing.status + '). Please wait for it to finish before booking another ride.');
        return true;
      }
      session.rideBooking = { step: 'pickup', pickup_address: '', destination_address: '', pickup_lat: null, pickup_lng: null, destination_lat: null, destination_lng: null };
      await sendText(from, '🚗 *Book a Zenzora Ride*\n\nSend your pickup address or share your WhatsApp location pin.\n\nTo share a pin, tap 📎 → Location → Send current location.\n\nType *cancel* at any time to stop.');
      return true;
    }

    if (!state) return false;

    if (state.step === 'pickup') {
      if (location && Number.isFinite(Number(location.latitude)) && Number.isFinite(Number(location.longitude))) {
        state.pickup_lat = Number(location.latitude);
        state.pickup_lng = Number(location.longitude);
        state.pickup_address = 'WhatsApp location pin (' + state.pickup_lat + ', ' + state.pickup_lng + ')';
      } else if (text && !listId && !btnId) {
        state.pickup_address = text.trim().slice(0, 500);
      } else {
        await sendText(from, 'Please send your pickup address or share a WhatsApp location pin.');
        return true;
      }
      if (state.pickup_address.length < 5) {
        await sendText(from, 'Please send a more complete pickup address or a location pin.');
        return true;
      }
      state.step = 'destination';
      await sendText(from, '📍 Pickup saved. Now send your destination address or share its WhatsApp location pin.');
      return true;
    }

    if (state.step === 'destination') {
      if (location && Number.isFinite(Number(location.latitude)) && Number.isFinite(Number(location.longitude))) {
        state.destination_lat = Number(location.latitude);
        state.destination_lng = Number(location.longitude);
        state.destination_address = 'WhatsApp location pin (' + state.destination_lat + ', ' + state.destination_lng + ')';
      } else if (text && !listId && !btnId) {
        state.destination_address = text.trim().slice(0, 500);
      } else {
        await sendText(from, 'Please send your destination address or share a WhatsApp location pin.');
        return true;
      }
      if (state.destination_address.length < 5) {
        await sendText(from, 'Please send a more complete destination address or a location pin.');
        return true;
      }
      state.step = 'passengers';
      await sendText(from, 'How many passengers are travelling? Reply with a number from 1 to 4.');
      return true;
    }

    if (state.step === 'passengers') {
      const count = Number(String(text || '').trim());
      if (!Number.isInteger(count) || count < 1 || count > 4) {
        await sendText(from, 'Please enter a whole number from 1 to 4 passengers.');
        return true;
      }
      const payload = {
        customer_phone: from,
        pickup_address: state.pickup_address,
        destination_address: state.destination_address,
        pickup_lat: state.pickup_lat,
        pickup_lng: state.pickup_lng,
        destination_lat: state.destination_lat,
        destination_lng: state.destination_lng,
        passenger_count: count,
        status: 'SEARCHING',
        customer_notified_status: 'SEARCHING'
      };
      const { data: trip, error: insertError } = await supabase
        .from('ride_requests')
        .insert(payload)
        .select('id, status')
        .single();
      delete session.rideBooking;
      if (insertError || !trip) {
        console.error('Ride request creation failed:', insertError?.message);
        await sendText(from, 'Sorry, I could not create your ride request. No payment has been taken. Please try again shortly.');
        return true;
      }
      await sendText(from,
        '✅ *Your Zenzora ride request has been sent.*\n\nPickup: ' + payload.pickup_address +
        '\nDestination: ' + payload.destination_address +
        '\nPassengers: ' + count +
        '\nStatus: Finding an approved driver.\n\nThe fare has not been charged or confirmed yet. We will update you when a driver responds.'
      );
      return true;
    }

    return false;
  }

  handleRideBookingMessage.notifyCustomers = notifyRideCustomers;
  return handleRideBookingMessage;
};
