import React, { useState, useEffect } from "react";
import { RevenueSummary } from "./RevenueSummary";
import { SecureAPI } from "../lib/secureApi";

interface Property {
  id: string;
  name: string;
}

const FALLBACK_PROPERTIES: Property[] = [
  { id: 'prop-001', name: 'Beach House Alpha' },
  { id: 'prop-002', name: 'City Apartment Downtown' },
  { id: 'prop-003', name: 'Country Villa Estate' },
  { id: 'prop-004', name: 'Lakeside Cottage' },
  { id: 'prop-005', name: 'Urban Loft Modern' }
];

const TENANT_PROPERTIES: Record<string, Property[]> = {
  'tenant-a': [
    { id: 'prop-001', name: 'Beach House Alpha' },
    { id: 'prop-002', name: 'City Apartment Downtown' },
    { id: 'prop-003', name: 'Country Villa Estate' },
  ],
  'tenant-b': [
    { id: 'prop-001', name: 'Mountain Lodge Beta' },
    { id: 'prop-004', name: 'Lakeside Cottage' },
    { id: 'prop-005', name: 'Urban Loft Modern' },
  ],
};

const Dashboard: React.FC = () => {
  const [properties, setProperties] = useState<Property[]>([]);
  const [selectedProperty, setSelectedProperty] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadProperties = async () => {
      try {
        const authInfo = await SecureAPI.getAuthMe();
        const tenantId = authInfo?.tenant_id;
        const tenantProps = tenantId ? TENANT_PROPERTIES[tenantId] : null;
        const resolved = tenantProps || FALLBACK_PROPERTIES;
        setProperties(resolved);
        setSelectedProperty(resolved[0]?.id || '');
      } catch {
        setProperties(FALLBACK_PROPERTIES);
        setSelectedProperty(FALLBACK_PROPERTIES[0]?.id || '');
      } finally {
        setLoading(false);
      }
    };
    loadProperties();
  }, []);

  if (loading) {
    return (
      <div className="p-4 lg:p-6 min-h-full">
        <div className="max-w-7xl mx-auto">
          <div className="animate-pulse space-y-4">
            <div className="h-8 bg-gray-100 rounded w-1/3"></div>
            <div className="h-64 bg-gray-100 rounded"></div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 lg:p-6 min-h-full">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-2xl font-bold mb-6 text-gray-900">Property Management Dashboard</h1>

        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 lg:p-6">
          <div className="mb-6">
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-4">
              <div>
                <h2 className="text-lg lg:text-xl font-medium text-gray-900 mb-2">Revenue Overview</h2>
                <p className="text-sm lg:text-base text-gray-600">
                  Monthly performance insights for your properties
                </p>
              </div>

              {/* Property Selector */}
              <div className="flex flex-col sm:items-end">
                <label className="text-xs font-medium text-gray-700 mb-1">Select Property</label>
                <select
                  value={selectedProperty}
                  onChange={(e) => setSelectedProperty(e.target.value)}
                  className="block w-full sm:w-auto min-w-[200px] px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 text-sm"
                >
                  {properties.map((property) => (
                    <option key={property.id} value={property.id}>
                      {property.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="space-y-6">
            {selectedProperty && <RevenueSummary propertyId={selectedProperty} />}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
