export interface ClinikoLinks {
  self?: string;
  next?: string;
  previous?: string;
}

export interface ClinikoPhoneNumber {
  number: string;
  normalized_number?: string;
  phone_type?: string;
}

export interface ClinikoPatient {
  id: string;
  first_name: string;
  preferred_first_name?: string | null;
  last_name: string;
  label?: string | null;
  email?: string | null;
  time_zone?: string | null;
  accepted_privacy_policy?: boolean | null;
  patient_phone_numbers?: ClinikoPhoneNumber[] | null;
  links?: ClinikoLinks;
}

export interface ClinikoIndividualAppointment {
  id: string;
  starts_at: string;
  ends_at: string;
  cancelled_at?: string | null;
  notes?: string | null;
  patient?: { id?: string; links?: ClinikoLinks };
  practitioner?: { id?: string; label?: string; links?: ClinikoLinks };
  business?: { id?: string; name?: string; links?: ClinikoLinks };
  appointment_type?: { id?: string; name?: string; links?: ClinikoLinks };
  links?: ClinikoLinks;
}

export interface ClinikoAppointmentType {
  id: string;
  name: string;
  duration_in_minutes?: number;
  show_in_online_bookings?: boolean | null;
  links?: ClinikoLinks;
}

export interface ClinikoPractitioner {
  id: string;
  label?: string;
  first_name?: string;
  last_name?: string;
  links?: ClinikoLinks;
}

export interface ClinikoBusiness {
  id: string;
  name: string;
  time_zone?: string;
  address_1?: string | null;
  city?: string | null;
  links?: ClinikoLinks;
}

export interface ClinikoTreatmentNoteQuestion {
  name?: string;
  answer?: string | number | boolean | null;
  type?: string;
}

export interface ClinikoTreatmentNote {
  id: string;
  title?: string;
  author_name?: string | null;
  created_at: string;
  finalized_at?: string | null;
  draft?: boolean | null;
  content?: {
    sections?: Array<{
      name?: string;
      description?: string;
      questions?: ClinikoTreatmentNoteQuestion[];
    }>;
  } | null;
  links?: ClinikoLinks;
}

export interface ClinikoAvailableTime {
  appointment_start: string;
}

export interface ClinikoPage<T> {
  total_entries?: number;
  links?: ClinikoLinks;
  [key: string]: T[] | number | ClinikoLinks | undefined;
}
