import {
  ensureDefaultOwner,
  bootstrapDefaultData,
} from '../services/bootstrap.service';
import { User } from '../models/User';
import { Role } from '../types';

jest.mock('../models/User');
// The station-screen migration touches these; they're irrelevant to the owner seeder
jest.mock('../models/Order');
jest.mock('../models/Ticket');

describe('Default Owner Seeder (Bootstrap Service)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('ensureDefaultOwner', () => {
    test('Seeds a default owner when no owner exists in the database', async () => {
      (User.findOne as jest.Mock).mockResolvedValue(null);
      (User.hashPassword as jest.Mock).mockResolvedValue('hashed_owner_pwd');
      (User.create as jest.Mock).mockResolvedValue({
        _id: 'mock_owner_id',
        name: 'owner',
        role: Role.Owner,
        active: true,
        passwordHash: 'hashed_owner_pwd',
      });

      const result = await ensureDefaultOwner();

      expect(User.findOne).toHaveBeenCalledWith({ role: Role.Owner });
      expect(User.hashPassword).toHaveBeenCalledWith(expect.any(String));
      expect(User.create).toHaveBeenCalledWith({
        name: expect.any(String),
        role: Role.Owner,
        passwordHash: 'hashed_owner_pwd',
        active: true,
      });
      expect(result).not.toBeNull();
      expect(result?.role).toBe(Role.Owner);
    });

    test('Does not seed or overwrite when an owner already exists in the database', async () => {
      (User.findOne as jest.Mock).mockResolvedValue({
        _id: 'existing_owner_id',
        name: 'super_boss',
        role: Role.Owner,
      });

      const result = await ensureDefaultOwner();

      expect(User.findOne).toHaveBeenCalledWith({ role: Role.Owner });
      expect(User.hashPassword).not.toHaveBeenCalled();
      expect(User.create).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });

    test('Handles database lookup errors gracefully without throwing', async () => {
      (User.findOne as jest.Mock).mockRejectedValue(new Error('DB Connection Timeout'));

      const result = await ensureDefaultOwner();

      expect(result).toBeNull();
    });
  });

  describe('bootstrapDefaultData', () => {
    test('Ensures default owner exists on server startup', async () => {
      (User.findOne as jest.Mock).mockResolvedValue(null);
      (User.hashPassword as jest.Mock).mockResolvedValue('hashed_pwd');
      (User.create as jest.Mock).mockResolvedValue({
        name: 'owner',
        role: Role.Owner,
      });

      await bootstrapDefaultData();

      expect(User.findOne).toHaveBeenCalledWith({ role: Role.Owner });
      expect(User.create).toHaveBeenCalled();
    });
  });
});
